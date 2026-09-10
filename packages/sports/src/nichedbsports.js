/**
 * Sports, mirrored from nichedb.dev.
 *
 * nichedb's `sports` collection is this site's own ESPN and Live Tennis adapters,
 * ported there and run there: the same catalogue, the same fixtures, the same
 * every-minute live pass. So this provider does not fetch a scoreboard. It reads
 * the collection and projects it into the tables the direct adapters already
 * write -- leagues, teams, team_leagues, events -- keeping `provider` as `espn` or
 * `livetennis` on every row, so a page, a follow or a bookmark cannot tell which
 * way the data arrived and nothing about ESPN's provider keys has to change for a
 * rollback.
 *
 * The contract it reads is docs/consolidation.md in the nichedb repo: kinds
 * `league`, `team`, `fixture`, with the fixture's whole record under `data`.
 *
 * Three passes, on the schedulers the direct adapters already had:
 *
 *   - the full sweep walks every league, every team and every fixture from the
 *     backfill floor forward -- about a hundred pages at 200 items each;
 *   - the near pass and the live tick both ask `since=<last sync>` and get only
 *     what nichedb changed, which on a quiet minute is one request returning
 *     nothing and on a busy evening is a page or two.
 *
 * Every walk is a keyset on id (`sort=id&order=asc&after=<id>`) over a filter
 * (`since` on updated_at, or `from` on published_at), because the item on the
 * wire carries no updated_at to page on. A walk can be cut short by the hourly
 * budget; then its position is kept in the cursor and whichever pass runs next
 * resumes it before doing its own work, so a long walk finishes over the following
 * minutes rather than being lost.
 */

import { config } from '@tipoff/config';
import * as q from '@tipoff/db/queries';
import { getJson } from './http.js';

export const name = 'nichedb-sports';

/** nichedb caps a page at 200 however much you ask for. */
export const PAGE = 200;

/** The sync_cursors row this provider keeps. */
export const CURSOR = 'nichedb-sports';

/**
 * How far behind its own start a walk sets the next `since`.
 *
 * A row updated while a walk is in flight may already have been passed by the id
 * keyset. Starting the next walk two minutes before this one began re-reads it;
 * the upserts are idempotent, so the overlap costs nothing but a few rows.
 */
export const OVERLAP_MS = 2 * 60_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * ESPN's tennis is skipped, as nichedb's own ESPN sources skip it by default.
 *
 * Live Tennis owns the sport on both sides, under the same league slugs
 * (`tennis-atp`, `tennis-wta`), and leagues.slug is unique -- migration 0028
 * already moved this site's ESPN tennis rows out of the way. Should nichedb ever
 * be configured to emit ESPN tennis, mirroring it would abort the batch on the
 * first slug collision, so it is dropped here on purpose.
 */
const skipped = (provider, sport) => provider === 'espn' && sport === 'tennis';

/* ---------------------------------------------------------------- mapping -- */

/** nichedb states are already pre/in/post; anything else is treated as pre. */
export function stateOf(data) {
  const s = data?.state;
  return s === 'in' || s === 'post' ? s : 'pre';
}

/** The team slug convention the direct adapters use: league slug + upstream id. */
export const teamSlug = (leagueSlug, key) => `${leagueSlug}-${String(key).split('/').pop()}`;

const text = (v) => (typeof v === 'string' && v.trim() ? v : null);
const int = (v) => (Number.isFinite(v) ? Math.trunc(v) : null);
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

/** A `league` item -> a leagues row, or null when it is not one we store. */
export function mapLeague(item, { now = Date.now() } = {}) {
  const d = item?.data;
  if (item?.kind !== 'league' || !d?.provider || !d.key || !d.slug || !d.sport) return null;
  if (skipped(d.provider, d.sport)) return null;
  return {
    provider: d.provider,
    provider_key: d.key,
    sport: d.sport,
    slug: d.slug,
    name: text(d.name) ?? text(item.title) ?? d.slug,
    abbreviation: text(d.abbreviation),
    logo_url: text(d.logoUrl) ?? text(item.image_url),
    priority: Number.isFinite(d.priority) ? d.priority : 100,
    region: text(d.region),
    abbr_ambiguous: d.abbrAmbiguous === true,
    plays_supported: d.plays_supported !== false,
    boxscore_supported: d.boxscoreSupported !== false,
    // The catalogue pass is the roster sync under this provider: the teams walk
    // that follows it carries every club in every league. This is the stamp the
    // boot check reads to decide whether the full sweep is overdue.
    rosters_synced_at: new Date(now),
    active: true,
  };
}

/** The key of the competition a duplicate league is superseded by, if any. */
export const supersededKeyOf = (item) => text(item?.data?.supersededBy);

/**
 * A league from a fixture that names one we have not seen.
 *
 * The daily catalogue is the authority, but a fixture can arrive first -- a new
 * competition, or a fresh database whose live tick ran before its first sweep --
 * and a fixture with nowhere to go would be dropped. This is enough of a league
 * row for the fixture to land; the next catalogue pass fills in the rest.
 */
export function leagueFromFixture(data) {
  const l = data?.league;
  if (!data?.provider || !data.sport || !l?.slug || !l.key) return null;
  if (skipped(data.provider, data.sport)) return null;
  return {
    provider: data.provider,
    provider_key: l.key,
    sport: data.sport,
    slug: l.slug,
    name: text(l.name) ?? l.slug,
    abbreviation: text(l.abbreviation),
    logo_url: null,
    priority: 100,
    region: text(l.region),
    abbr_ambiguous: false,
    plays_supported: data.plays_supported !== false,
    boxscore_supported: data.boxscoreSupported !== false,
    rosters_synced_at: null,
    active: true,
  };
}

/** One side of a fixture, or a `team` item's record -> a teams row minus its league. */
function teamRow(d, item = null) {
  if (!d?.key) return null;
  const displayName = text(d.displayName) ?? text(d.name) ?? text(item?.title);
  if (!displayName) return null;
  return {
    provider_key: d.key,
    name: text(d.name) ?? displayName,
    display_name: displayName,
    abbreviation: text(d.abbreviation),
    logo_url: text(d.logoUrl) ?? text(item?.image_url),
  };
}

/** A `team` item -> its row and the league slugs it plays in. */
export function mapTeam(item) {
  const d = item?.data;
  if (item?.kind !== 'team' || !d?.provider || !d.sport) return null;
  if (skipped(d.provider, d.sport)) return null;
  const row = teamRow(d, item);
  const leagues = (Array.isArray(d.leagues) ? d.leagues : []).filter(
    (s) => typeof s === 'string' && s,
  );
  if (!row || leagues.length === 0) return null;
  return { row: { provider: d.provider, ...row }, leagues };
}

/**
 * A `fixture` item -> everything the events upsert needs, plus the league and the
 * two sides so the caller can resolve foreign keys.
 *
 * Every row carries the same keys whatever the sport, because the upsert builds
 * its column list from the first row of the batch.
 */
export function mapFixture(item) {
  const d = item?.data;
  if (item?.kind !== 'fixture' || !d?.provider || !d.key || !d.sport || !d.league?.slug) {
    return null;
  }
  if (skipped(d.provider, d.sport)) return null;
  // published_at is when it happens. A fixture without one has no place on a
  // calendar, and starts_at is not null.
  const startsAt = item.published_at ? new Date(item.published_at) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) return null;

  const home = teamRow(d.home);
  const away = teamRow(d.away);
  const broadcast = text(d.broadcast);
  const markets =
    Array.isArray(d.broadcastMarkets) && d.broadcastMarkets.length > 0 ? d.broadcastMarkets : null;
  const timeKnown = item.time_known !== false;
  const odds = d.odds && typeof d.odds === 'object' ? d.odds : null;

  return {
    provider: d.provider,
    sport: d.sport,
    league: d.league,
    home,
    away,
    odds,
    event: {
      provider: d.provider,
      provider_key: d.key,
      starts_at: startsAt,
      time_known: timeKnown,
      precision: text(item.precision) ?? (timeKnown ? 'minute' : 'day'),
      state: stateOf(d),
      status_detail: text(d.statusDetail),
      name: text(d.name) ?? text(item.title) ?? 'Fixture',
      short_name: text(d.shortName) ?? text(item.summary),
      venue: text(d.venue),
      venue_city: text(d.venueCity),
      venue_region: text(d.venueRegion),
      neutral_site: d.neutralSite === true,
      broadcast,
      broadcast_source: text(d.broadcastSource) ?? (broadcast ? 'espn' : null),
      broadcast_country: text(markets?.[0]?.country) ?? (broadcast ? 'United States' : null),
      broadcast_markets: json(markets),
      attendance: int(d.attendance),
      period: int(d.period),
      display_clock: text(d.displayClock),
      score_detail: json(d.scoreDetail ?? null),
      odds: json(odds),
      home_record: text(d.home?.record),
      away_record: text(d.away?.record),
      home_score: int(d.home?.score),
      away_score: int(d.away?.score),
    },
  };
}

/* ------------------------------------------------------------------- odds -- */

/**
 * The fields a snapshot is made of, and nothing else.
 *
 * `capturedAt` is re-stamped on every pass upstream, so a naive comparison of the
 * two objects would find a change every minute. This is the same set of columns
 * recordOddsSnapshots compares against the previous reading.
 */
const ODDS_FIELDS = [
  'provider',
  'details',
  'spread',
  'overUnder',
  'favorite',
  'homeMoneyline',
  'awayMoneyline',
  'drawMoneyline',
];

export function oddsFingerprint(odds) {
  if (!odds || typeof odds !== 'object') return null;
  return JSON.stringify(ODDS_FIELDS.map((k) => odds[k] ?? null));
}

/** Whether the line arriving differs from the one stored. Nothing arriving is not a change. */
export function oddsChanged(stored, incoming) {
  const next = oddsFingerprint(incoming);
  return next !== null && next !== oddsFingerprint(stored);
}

/* ----------------------------------------------------------------- paging -- */

/**
 * One page of a kind: oldest id first, keyset on `after`, filtered by `since`
 * (updated_at) or `from` (published_at). The base is a parameter so a test can
 * point it anywhere.
 */
export function pageUrl({ base, kind, since = null, from = null, afterId = 0, limit = PAGE }) {
  const p = new URLSearchParams({
    collection: 'sports',
    kind,
    sort: 'id',
    order: 'asc',
    limit: String(limit),
  });
  if (since) p.set('since', since);
  if (from) p.set('from', from);
  if (afterId) p.set('after', String(afterId));
  return `${base ?? config.sports.nichedb.baseUrl}/items?${p}`;
}

export const utcHour = (now = Date.now()) => new Date(now).toISOString().slice(0, 13);

/**
 * This hour's spend, from the cursor, rolled over on the hour -- the way the
 * provider counts it.
 */
export function budgetFrom(
  cursor,
  { now = Date.now(), limit = config.sports.nichedb.hourlyBudget },
) {
  const hour = utcHour(now);
  const same = cursor?.spend?.hour === hour;
  const state = {
    hour,
    calls: same ? Number(cursor.spend.calls) || 0 : 0,
    limit: Math.max(1, limit),
  };
  return {
    state,
    /** Take one request from the hour, or say there are none left. */
    spend() {
      if (state.calls >= state.limit) return false;
      state.calls += 1;
      return true;
    },
  };
}

/** Where the whole walk starts: the backfill floor, never less than six hours back. */
export function backfillFrom(now = Date.now(), days = config.sports.backfillDays) {
  const backMs = Math.max(6 * HOUR_MS, (Number(days) || 0) * DAY_MS);
  return new Date(now - backMs).toISOString();
}

/* ---------------------------------------------------------------- writing -- */

/** The default store: the real queries. A test hands in a fake. */
export function defaultStore() {
  return {
    leagueIndex: () => q.leagueIndex(),
    upsertLeague: (row) => q.upsertMirroredLeague(row),
    linkSuperseded: (ref) => q.linkSupersededLeague(ref),
    upsertTeams: (rows) => q.upsertTeams(rows),
    linkTeamsToLeague: (ids, leagueId) => q.linkTeamsToLeague(ids, leagueId),
    upsertEvents: (rows) => q.upsertEvents(rows),
    oddsByEventKeys: (refs) => q.oddsByEventKeys(refs),
    recordOddsSnapshots: (ids) => q.recordOddsSnapshots(ids),
    getCursor: () => q.getSyncCursor(CURSOR),
    setCursor: (cursor) => q.setSyncCursor(CURSOR, cursor),
  };
}

/** The leagues we know, by slug and by provider key, growing as a run creates more. */
async function loadIndex(store) {
  const bySlug = new Map();
  const byKey = new Map();
  const add = (row) => {
    bySlug.set(row.slug, row);
    byKey.set(`${row.provider}|${row.provider_key}`, row);
    return row;
  };
  for (const row of await store.leagueIndex()) add(row);
  return {
    bySlug,
    byKey,
    add,
    find: (provider, league) =>
      bySlug.get(league?.slug) ?? byKey.get(`${provider}|${league?.key}`) ?? null,
  };
}

async function applyLeagues(items, ctx) {
  const superseded = [];
  let n = 0;
  for (const item of items) {
    const row = mapLeague(item, { now: ctx.now });
    if (!row) continue;
    const saved = await ctx.store.upsertLeague(row);
    ctx.index.add(saved);
    n++;
    const key = supersededKeyOf(item);
    if (key) superseded.push({ id: saved.id, provider: row.provider, providerKey: key });
  }
  // After the batch, so the surviving row can be in the same page as its duplicate.
  for (const ref of superseded) await ctx.store.linkSuperseded(ref);
  ctx.stats.leagues += n;
}

/**
 * Teams, and the edges to every competition they play in.
 *
 * A team item names its leagues by slug. Its row is filed under the first, which
 * is where its slug comes from; the rest are edges.
 */
async function applyTeams(items, ctx) {
  const rows = new Map();
  const edges = new Map();
  for (const item of items) {
    const mapped = mapTeam(item);
    if (!mapped) continue;
    const leagues = mapped.leagues.map((s) => ctx.index.bySlug.get(s)).filter(Boolean);
    if (leagues.length === 0) {
      ctx.stats.orphans++;
      continue;
    }
    // On provider_key alone, for the reason applyFixtures gives.
    const key = mapped.row.provider_key;
    if (!rows.has(key)) {
      rows.set(key, {
        ...mapped.row,
        league_id: leagues[0].id,
        slug: teamSlug(leagues[0].slug, key),
      });
    }
    for (const l of leagues) {
      if (!edges.has(l.id)) edges.set(l.id, new Set());
      edges.get(l.id).add(key);
    }
  }
  if (rows.size === 0) return;
  const saved = await ctx.store.upsertTeams([...rows.values()]);
  const idOf = new Map(saved.map((r) => [r.provider_key, r.id]));
  for (const [leagueId, keys] of edges) {
    const ids = [...keys].map((k) => idOf.get(k)).filter(Boolean);
    await ctx.store.linkTeamsToLeague(ids, leagueId);
  }
  ctx.stats.teams += rows.size;
}

/**
 * Fixtures: the league first (creating it if it has to), then both sides, then
 * the events, then a snapshot of any line that moved.
 */
async function applyFixtures(items, ctx) {
  const fixtures = [];
  for (const item of items) {
    const f = mapFixture(item);
    if (!f) continue;
    let league = ctx.index.find(f.provider, f.league);
    if (!league) {
      const row = leagueFromFixture(item.data);
      if (!row) continue;
      league = ctx.index.add(await ctx.store.upsertLeague(row));
      ctx.stats.leaguesCreated++;
    }
    fixtures.push({ ...f, leagueRow: league });
  }
  if (fixtures.length === 0) return;

  // Both sides of every fixture, once each, filed under the fixture's league.
  //
  // Keyed on provider_key alone, which is what upsertTeams hands back: an ESPN key
  // is `<sport>/<league>/<id>` and a Live Tennis one `livetennis/<p|d><id>`, so
  // the two providers cannot collide on it.
  const teamRows = new Map();
  const edges = new Map();
  for (const f of fixtures) {
    for (const side of [f.home, f.away]) {
      if (!side) continue;
      if (!teamRows.has(side.provider_key)) {
        teamRows.set(side.provider_key, {
          provider: f.provider,
          ...side,
          league_id: f.leagueRow.id,
          slug: teamSlug(f.leagueRow.slug, side.provider_key),
        });
      }
      if (!edges.has(f.leagueRow.id)) edges.set(f.leagueRow.id, new Set());
      edges.get(f.leagueRow.id).add(side.provider_key);
    }
  }
  const teamId = new Map();
  if (teamRows.size > 0) {
    const saved = await ctx.store.upsertTeams([...teamRows.values()]);
    for (const r of saved) teamId.set(r.provider_key, r.id);
    for (const [leagueId, keys] of edges) {
      const ids = [...keys].map((k) => teamId.get(k)).filter(Boolean);
      await ctx.store.linkTeamsToLeague(ids, leagueId);
    }
  }

  // What each fixture's line was before this page lands, so only a moved line
  // gets a snapshot. recordOddsSnapshots compares again inside the statement; this
  // read keeps the every-minute pass from sending it every fixture every time.
  const withOdds = fixtures.filter((f) => f.odds);
  const stored = new Map();
  if (withOdds.length > 0) {
    const refs = withOdds.map((f) => ({
      provider: f.provider,
      provider_key: f.event.provider_key,
    }));
    for (const r of await ctx.store.oddsByEventKeys(refs)) {
      stored.set(r.provider_key, r.odds ?? null);
    }
  }
  const moved = new Set(
    withOdds
      .filter((f) => oddsChanged(stored.get(f.event.provider_key), f.odds))
      .map((f) => f.event.provider_key),
  );

  const eventRows = fixtures.map((f) => ({
    ...f.event,
    league_id: f.leagueRow.id,
    home_team_id: f.home ? (teamId.get(f.home.provider_key) ?? null) : null,
    away_team_id: f.away ? (teamId.get(f.away.provider_key) ?? null) : null,
  }));
  const saved = await ctx.store.upsertEvents(eventRows);
  ctx.stats.fixtures += eventRows.length;
  for (const f of fixtures) if (f.event.state === 'in') ctx.stats.live++;

  if (moved.size > 0) {
    const ids = saved.filter((r) => moved.has(r.provider_key)).map((r) => r.id);
    try {
      ctx.stats.snapshots += Number(await ctx.store.recordOddsSnapshots(ids)) || 0;
    } catch (err) {
      // The archive is a by-product of having the fixtures; it must not fail them.
      ctx.log(`[mirror] odds snapshot write failed: ${err?.message ?? err}`);
    }
  }
}

const APPLY = { league: applyLeagues, team: applyTeams, fixture: applyFixtures };

/* ---------------------------------------------------------------- walking -- */

/**
 * One walk, resumed from the cursor if it is the one that was cut short.
 *
 * Returns true when the walk reached its end, false when the hour's budget ran
 * out first -- in which case its position is in `cursor.pending` for the next pass.
 */
async function walk(spec, ctx) {
  const pending = ctx.cursor.pending?.id === spec.id ? ctx.cursor.pending : null;
  const state = pending ?? {
    id: spec.id,
    kind: spec.kind,
    since: spec.since ?? null,
    from: spec.from ?? null,
    afterId: 0,
    startedAt: new Date(ctx.now).toISOString(),
  };
  if (pending) ctx.stats.resumed.push(spec.id);

  for (;;) {
    if (!ctx.budget.spend()) {
      ctx.cursor.pending = state;
      ctx.stats.exhausted = true;
      return false;
    }
    const url = pageUrl({ base: ctx.base, ...state });
    const items = (await ctx.http(url, { timeoutMs: 30_000 }))?.items ?? [];
    ctx.stats.requests++;
    await APPLY[state.kind](items, ctx);
    if (items.length > 0) state.afterId = Number(items[items.length - 1].id) || state.afterId;
    if (items.length < PAGE) break;
  }

  ctx.cursor.pending = null;
  if (state.kind === 'fixture') {
    // Every fixture that changed before this walk began has now been seen, so the
    // next since-sync starts there -- less the overlap, for the ones that changed
    // during it. Never moved backwards: a resumed old walk must not undo a newer one.
    const next = new Date(Date.parse(state.startedAt) - OVERLAP_MS).toISOString();
    if (!ctx.cursor.since || next > ctx.cursor.since) ctx.cursor.since = next;
  }
  return true;
}

/**
 * The walks a pass wants, in order, with an interrupted one from an earlier pass
 * put first. A pass can apply any kind, so it finishes what another started.
 */
async function runWalks(specs, ctx) {
  const list = [...specs];
  const pending = ctx.cursor.pending;
  if (pending && !list.some((s) => s.id === pending.id)) {
    list.unshift({ id: pending.id, kind: pending.kind, since: pending.since, from: pending.from });
  }
  for (const spec of list) {
    if (!(await walk(spec, ctx))) return false;
  }
  return true;
}

/** Only one pass at a time in this process: the cursor is one row. */
let inflight = null;

/**
 * Load the cursor, take the hour's budget, run, and write the cursor back whatever
 * happened -- the upserts already landed, and the position is what a retry needs.
 */
async function withRun({ store, http, log, now, base, hourlyBudget }, fn) {
  if (inflight) return { skipped: 'a mirror pass is already running' };
  const run = (async () => {
    const cursor = { ...((await store.getCursor()) ?? {}) };
    const budget = budgetFrom(cursor, { now, limit: hourlyBudget });
    const ctx = {
      store,
      http,
      log,
      now,
      base,
      cursor,
      budget,
      index: await loadIndex(store),
      stats: {
        requests: 0,
        leagues: 0,
        teams: 0,
        fixtures: 0,
        live: 0,
        leaguesCreated: 0,
        orphans: 0,
        snapshots: 0,
        resumed: [],
        exhausted: false,
      },
    };
    try {
      await fn(ctx);
    } finally {
      cursor.spend = { hour: budget.state.hour, calls: budget.state.calls };
      await store.setCursor(cursor);
    }
    return { ...ctx.stats, cursor, spent: `${budget.state.calls}/${budget.state.limit}` };
  })();
  inflight = run;
  try {
    return await run;
  } finally {
    inflight = null;
  }
}

const fixturesSince = (cursor, now) =>
  cursor.since
    ? { id: 'fixtures:since', kind: 'fixture', since: cursor.since }
    : // Never synced: the first pass IS the backfill, however it was scheduled.
      { id: 'fixtures:all', kind: 'fixture', from: backfillFrom(now) };

const catalogueSpecs = () => [
  { id: 'catalogue:league', kind: 'league' },
  { id: 'catalogue:team', kind: 'team' },
];

function summary(stats, what) {
  const tail = [
    stats.leaguesCreated ? `${stats.leaguesCreated} league(s) created from fixtures` : null,
    stats.orphans ? `${stats.orphans} team(s) with no known league` : null,
    stats.snapshots ? `${stats.snapshots} odds snapshot(s)` : null,
    stats.resumed.length ? `resumed ${stats.resumed.join(', ')}` : null,
    stats.exhausted ? 'hourly budget spent, continuing next pass' : null,
  ].filter(Boolean);
  return (
    `[mirror] ${what}: ${stats.leagues} leagues, ${stats.teams} teams, ${stats.fixtures} fixtures ` +
    `(${stats.live} live) from ${stats.requests} request(s), ${stats.spent} this hour` +
    (tail.length ? `; ${tail.join('; ')}` : '')
  );
}

/** Every knob a pass has, with the real store, the shared http helper and config behind it. */
const defaults = (opts) => ({
  store: opts.store ?? defaultStore(),
  http: opts.http ?? getJson,
  log: opts.log ?? console.log,
  now: opts.now ?? Date.now(),
  base: opts.base ?? config.sports.nichedb.baseUrl,
  hourlyBudget: opts.hourlyBudget ?? config.sports.nichedb.hourlyBudget,
});

/** Leagues and teams, whole. The daily catalogue. */
export async function syncCatalogue(opts = {}) {
  const ctx = defaults(opts);
  const out = await withRun(ctx, (run) => runWalks(catalogueSpecs(), run));
  if (!out.skipped) ctx.log(summary(out, 'catalogue'));
  return out;
}

/** The catalogue, then every fixture from the backfill floor forward. The daily sweep. */
export async function syncAll(opts = {}) {
  const ctx = defaults(opts);
  const out = await withRun(ctx, (run) =>
    runWalks(
      [...catalogueSpecs(), { id: 'fixtures:all', kind: 'fixture', from: backfillFrom(ctx.now) }],
      run,
    ),
  );
  if (!out.skipped) ctx.log(summary(out, 'full'));
  return out;
}

/** Only what changed since the last look. The near pass and the live tick. */
export async function syncSince(opts = {}) {
  const ctx = defaults(opts);
  const out = await withRun(ctx, (run) => runWalks([fixturesSince(run.cursor, ctx.now)], run));
  if (!out.skipped) ctx.log(summary(out, 'since'));
  return out;
}
