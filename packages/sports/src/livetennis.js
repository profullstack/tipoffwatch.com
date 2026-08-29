/**
 * Live Tennis API -- the tennis provider, in place of ESPN.
 *
 * ESPN publishes tennis as a fortnight-shaped "event" holding a `groupings` tree of
 * draws, which this repo already flattens (see espn.js). It works, but it is a thin
 * read of the sport: main-tour only in practice, no ranking, no surface, no round,
 * and a scoreline reconstructed from linescores. This provider answers in tennis's
 * own vocabulary -- ATP, WTA, Challenger and ITF, singles and doubles, with the
 * current server, the points in the game being played, games per set, surface,
 * round and both players' rankings -- so tennis stops being the sport that fits
 * worst into a fixture table.
 *
 * The whole design of this file is shaped by ONE constraint: the free key allows
 * **100 requests per day**. That is less than the live tick alone would spend in
 * two hours, so an adapter written like espn.js -- one upstream request per league
 * per pass -- would be locked out before breakfast and stay locked out. Two things
 * follow, and neither is optional:
 *
 *  1. **The provider is read whole, not per league.** `/matches` is not scoped to a
 *     tour, so one response already holds ATP, WTA, Challenger and ITF. Every
 *     league in a pass therefore shares one snapshot and filters it locally, which
 *     turns "four leagues" from four requests into nothing extra at all.
 *  2. **A snapshot has a minimum age, and the day has a hard ceiling.** The live
 *     tick asks every 60 seconds; it is answered from cache until the snapshot is
 *     older than `liveTtlSeconds`. Above that sits a day counter that simply stops
 *     spending, and serves the last snapshot it has rather than throwing -- a
 *     stale score is worth more than an empty page, and a 429 spent on nothing is
 *     worth less than both.
 *
 * At the defaults that is ~60 requests a day, comfortably inside 100 with room for
 * boot syncs and retries, and it buys live scores that are up to half an hour old.
 * That staleness is a free-tier fact rather than a design preference: the paid
 * tiers raise the ceiling to 1k/day (Basic), 10k (Pro) and 500k (Ultra), and the
 * only change needed is `LIVETENNIS_LIVE_TTL_SECONDS` down and
 * `LIVETENNIS_DAILY_BUDGET` up. See the table in packages/config.
 */
import { config } from '@tipoff/config';

const BASE = 'https://api.livetennisapi.com/api/public/v1';

export const name = 'livetennis';

/**
 * The sport this provider owns outright.
 *
 * `syncCatalogue` reads this and deactivates every other provider's tennis, which
 * is what stops ESPN and this adapter both writing the US Open under two different
 * league rows with two different sets of players. A claim is exclusive on purpose:
 * two sources for one sport is not redundancy, it is duplicate fixtures.
 */
export const claimsSports = ['tennis'];

/**
 * The tours, which are this provider's leagues.
 *
 * `tour` is what a match row carries, so it is the provider key. `other` is the
 * catch-all for the rows that carry no tour at all -- UTR events, exhibitions,
 * pre-season invitationals. They are real fixtures with real players and dropping
 * them silently is how a sport ends up with holes nobody can explain, so they get
 * a league of their own rather than being forced into ITF.
 */
const TOURS = [
  { key: 'atp', slug: 'tennis-atp', name: 'ATP Tour', abbreviation: 'ATP', priority: 3 },
  { key: 'wta', slug: 'tennis-wta', name: 'WTA Tour', abbreviation: 'WTA', priority: 3 },
  {
    key: 'challenger',
    slug: 'tennis-challenger',
    name: 'ATP Challenger Tour',
    abbreviation: 'CH',
    priority: 6,
  },
  {
    key: 'itf',
    slug: 'tennis-itf',
    name: 'ITF World Tennis Tour',
    abbreviation: 'ITF',
    priority: 8,
  },
  {
    key: 'other',
    slug: 'tennis-other',
    name: 'Other Tennis Events',
    abbreviation: 'TEN',
    priority: 12,
  },
];

const TOUR_KEYS = new Set(TOURS.map((t) => t.key));

/** A row's league. Anything the provider does not classify lands in `other`. */
const tourOf = (m) => {
  const t = String(m?.tour ?? '').toLowerCase();
  return TOUR_KEYS.has(t) && t !== 'other' ? t : 'other';
};

/**
 * Every tour, without asking the provider.
 *
 * ESPN's catalogue is fetched because it changes -- new competitions appear and the
 * sweep should find them without a deploy. The tours do not: there have been four
 * of them for decades, and `/tournaments` answers with 10,222 rows across every
 * season back to the 1960s, which is a catalogue of history rather than of leagues.
 * So this is a constant, and the daily catalogue sync costs this provider nothing.
 */
export async function listLeagues() {
  return TOURS.map((t) => ({
    provider: name,
    provider_key: t.key,
    sport: 'tennis',
    slug: t.slug,
    name: t.name,
    abbreviation: t.abbreviation,
    logo_url: null,
    priority: t.priority,
  }));
}

/*
 * ---------------------------------------------------------------------------
 * Budget
 * ---------------------------------------------------------------------------
 */

/** Requests spent today, reset when the UTC day rolls over -- as the provider counts it. */
let spend = { day: '', calls: 0, tape: 0 };

/**
 * What the provider says the ceiling is, learned rather than assumed.
 *
 * Null until `/usage` has been read. Used to clamp our own configured budget: a
 * `LIVETENNIS_DAILY_BUDGET` above the plan's real allowance is not a budget, it is
 * a promise nobody is keeping.
 */
let providerPerDay = null;

/** Whether today's count has been seeded from the provider, and the read in flight. */
let seeded = { day: '', inflight: null };

const utcDay = () => new Date().toISOString().slice(0, 10);

/** The lower of what we asked for and what the plan actually allows. */
function effectiveBudget() {
  const configured = config.sports.livetennis.dailyBudget;
  return providerPerDay === null ? configured : Math.min(configured, providerPerDay);
}

function rollDay() {
  const day = utcDay();
  if (spend.day !== day) spend = { day, calls: 0, tape: 0 };
  return day;
}

function budgetRemaining() {
  rollDay();
  return effectiveBudget() - spend.calls;
}

/** Visible for tests, and for a caller that wants to force a fresh read. */
export function resetBudget() {
  spend = { day: '', calls: 0, tape: 0 };
  providerPerDay = null;
  seeded = { day: '', inflight: null };
  snapshots.clear();
  taped.clear();
}

/** What the adapter has spent today, for the sync log. */
export const spentToday = () => ({
  day: spend.day,
  calls: spend.calls,
  tape: spend.tape,
  budget: effectiveBudget(),
  seeded: seeded.day === spend.day,
});

class BudgetExhausted extends Error {
  constructor(budget) {
    super(`livetennis daily budget of ${budget} requests is spent`);
    this.name = 'BudgetExhausted';
  }
}

/** The HTTP call itself, with no budget accounting -- see getJson for that. */
async function rawGet(path, { timeoutMs = 20000 } = {}) {
  const key = config.sports.livetennis.apiKey;
  if (!key) throw new Error('LIVETENNIS_API_KEY is not set');

  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', authorization: `Bearer ${key}` },
  });

  if (!res.ok) {
    /*
     * The body is the whole message here. A 403 on this provider is not "no" in
     * general, it is "not on this tier", and it names the capability, the tier that
     * carries it and the price -- which is the difference between a one-line log
     * and an afternoon wondering whether the key is wrong. Worth reading before
     * discarding.
     */
    const why = await res.text().catch(() => '');
    const err = new Error(`livetennis ${res.status} on ${path}: ${why.trim().slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Ask the provider what we have already spent today, once per process per day.
 *
 * The counter above lives in memory, and that was a real hole rather than a
 * theoretical one: every deploy restarts the process, so the count went back to
 * zero while the provider kept counting. On a day with four deploys the adapter
 * believed it had spent nothing while the provider had it at 65 of 100 -- so the
 * guard could not have stopped us crossing the real limit, which is 429s and
 * frozen scores rather than a graceful stop.
 *
 * `/usage` reports `today.calls` and `limits.per_day`, so the truth is one request
 * away. That request is worth it exactly once per boot: it converts a guess into
 * the provider's own number, and it also teaches us the plan's real ceiling, so
 * upgrading the key needs no redeploy to be believed.
 *
 * Deliberately not fatal. If `/usage` fails we fall back to counting locally from
 * zero, which is the old behaviour -- being unable to ASK how much is left is no
 * reason to stop working, and a provider that is down is not a budget problem.
 */
async function ensureSeeded() {
  const day = rollDay();
  if (seeded.day === day) return;
  if (seeded.inflight) return seeded.inflight;

  seeded.inflight = (async () => {
    try {
      const body = await rawGet('/usage');
      const used = body?.today?.calls;
      const perDay = body?.limits?.per_day;
      if (Number.isFinite(perDay) && perDay > 0) providerPerDay = perDay;
      if (Number.isFinite(used)) {
        // +1 for this very request, and never downward: a snapshot the provider
        // took a moment ago must not erase spending we know about since.
        spend.calls = Math.max(spend.calls, used + 1);
      } else {
        spend.calls += 1;
      }
      seeded = { day, inflight: null };
    } catch {
      // Leave `seeded.day` unset so a later call tries again -- but clear the
      // in-flight promise, or every subsequent request would await a settled
      // failure for the rest of the day.
      seeded = { day: '', inflight: null };
    }
  })();

  return seeded.inflight;
}

async function getJson(path, { timeoutMs = 20000, tape = false } = {}) {
  await ensureSeeded();

  if (budgetRemaining() <= 0) throw new BudgetExhausted(effectiveBudget());
  spend.calls++;
  if (tape) spend.tape++;

  return rawGet(path, { timeoutMs });
}

/**
 * Every page of a list endpoint, up to a cap.
 *
 * The provider pages at 100 and reports `meta.has_more`, and an unbounded follow of
 * that is exactly the shape that empties a 100-request budget in one pass. The cap
 * is on pages rather than rows for that reason: the window this adapter cares about
 * is two days wide and has never needed more than two.
 */
async function fetchPages(path, { maxPages }) {
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await getJson(`${path}${sep}limit=100&offset=${page * 100}`);
    rows.push(...(body.data ?? []));
    if (!body.meta?.has_more) break;
  }
  return rows;
}

/*
 * ---------------------------------------------------------------------------
 * Snapshots
 * ---------------------------------------------------------------------------
 */

/** kind -> { at, rows }. One shared read per kind, reused by every league in a pass. */
const snapshots = new Map();

/** In flight, so four leagues starting together make one request rather than four. */
const inflight = new Map();

const KINDS = {
  /**
   * What is being played right now. One request, and the only one that needs to be
   * repeated during the day.
   */
  live: {
    path: '/matches?status=live',
    maxPages: 2,
    ttl: () => config.sports.livetennis.liveTtlSeconds,
  },
  /**
   * What is about to be played. Tennis draws are made a day or two out, so this
   * never reaches the 14-day horizon the sweep asks for -- that is the sport, not a
   * gap in the provider, and it is why the fixture refresh can be hours apart.
   */
  upcoming: {
    path: '/matches?status=upcoming',
    maxPages: 2,
    ttl: () => config.sports.livetennis.fixturesTtlSeconds,
  },
  /**
   * What has just finished.
   *
   * Load-bearing, and the least obvious of the three: a match drops out of the live
   * list the moment it ends, so without this every fixture would be left sitting at
   * `in` with the last score anyone saw, forever. It is read from `/history` rather
   * than `/matches?status=completed` because paging completed matches is a Basic
   * capability and 403s on a free key, while the history list answers -- and if
   * that ever stops being true, `fetchSnapshot` degrades to an empty list rather
   * than failing the pass, and the closing read is simply lost.
   */
  recent: {
    path: '/history/matches',
    maxPages: 1,
    ttl: () => config.sports.livetennis.fixturesTtlSeconds,
    optional: true,
  },
};

/**
 * One kind of snapshot, fetched at most once per TTL and shared by every caller.
 *
 * On budget exhaustion or an upstream failure this returns the last snapshot it
 * holds rather than throwing. That is deliberate: the caller is a sync pass whose
 * alternative is writing nothing, and a score half an hour old is a far better
 * answer than a league page that empties itself every time the provider hiccups.
 */
async function snapshot(kind, { log = console.warn } = {}) {
  const spec = KINDS[kind];
  const held = snapshots.get(kind);
  const ttlMs = spec.ttl() * 1000;

  if (held && Date.now() - held.at < ttlMs) return held.rows;
  if (inflight.has(kind)) return inflight.get(kind);

  const p = (async () => {
    try {
      const rows = await fetchPages(spec.path, { maxPages: spec.maxPages });
      snapshots.set(kind, { at: Date.now(), rows });
      return rows;
    } catch (err) {
      // Do not cache the failure: the next pass should try again, subject to the
      // budget, rather than being told "no" for a whole TTL because of one blip.
      if (held) {
        log(`[livetennis] ${kind} refresh failed (${err?.message ?? err}); serving snapshot`);
        return held.rows;
      }
      if (spec.optional || err instanceof BudgetExhausted) {
        log(`[livetennis] ${kind} unavailable (${err?.message ?? err})`);
        return [];
      }
      throw err;
    } finally {
      inflight.delete(kind);
    }
  })();

  inflight.set(kind, p);
  return p;
}

/*
 * ---------------------------------------------------------------------------
 * Normalisation
 * ---------------------------------------------------------------------------
 */

/**
 * One side of a match: a player, or a doubles pair.
 *
 * The two are different id spaces -- there is a player 4382 and a pair 4382 -- and
 * the team slug is built from the last path segment of this key, so folding them
 * into one namespace would collide two unrelated competitors on a unique index
 * mid-sync. The `p`/`d` prefix keeps them apart, and keeps the key readable.
 *
 * The key deliberately carries no tour. A player who appears in an ITF draw one
 * week and a Challenger the next is one person and should be followed once; the
 * league membership is recorded on the edge (team_leagues) rather than baked into
 * the identity. That is the opposite of ESPN, where an id means nothing without its
 * league -- there, id 7 is both the Denver Broncos and the Amherst Mammoths.
 */
function side(p) {
  if (!p?.id || !p.name) return null;
  const isPair = p.is_doubles_team === true;

  return {
    providerKey: `${name}/${isPair ? 'd' : 'p'}${p.id}`,
    name: p.name,
    displayName: p.name,
    // A ranking is the closest thing tennis has to an abbreviation: it is short,
    // it is what a card has room for, and it is the thing a reader actually wants
    // next to the name. A pair has none, and gets nothing rather than "null".
    abbreviation: Number.isFinite(p.ranking) ? `#${p.ranking}` : null,
    logoUrl: null,
    country: p.country ? String(p.country).toUpperCase() : null,
    ranking: Number.isFinite(p.ranking) ? p.ranking : null,
  };
}

/** `pre` until it is being played, then `in`, then `post` -- the states events uses. */
function stateOf(m) {
  if (m.status === 'live') return 'in';
  if (m.status === 'completed' || m.status === 'cancelled' || m.outcome) return 'post';
  return 'pre';
}

/**
 * The line under the scoreline.
 *
 * Three different questions depending on where the match is: which round it is (not
 * yet started), which set is being played (in progress), and how it ended (over --
 * "retired" and "walkover" are results in tennis and must not read as "completed").
 */
function statusDetail(m) {
  const state = stateOf(m);
  if (state === 'post') {
    const outcome = m.outcome && m.outcome !== 'completed' ? m.outcome : m.event_status;
    return outcome ? String(outcome).replace(/^./, (c) => c.toUpperCase()) : 'Final';
  }
  if (state === 'in') {
    const set = m.score?.games?.[0]?.length ?? null;
    return set ? `Set ${set}` : 'Live';
  }
  return m.round || m.round_code || null;
}

/**
 * The scoreboard clock, which in tennis is the points in the game being played.
 *
 * `points` is already in tennis's own notation -- "0", "15", "30", "40", "A" -- so
 * it is passed through rather than translated, and the tiebreak flag is honoured
 * because "6-5" in a tiebreak means something different from "40-30" in a game.
 */
function displayClock(m) {
  const pts = m.score?.points;
  if (stateOf(m) !== 'in' || !Array.isArray(pts) || pts.length !== 2) return null;
  return m.score.is_tiebreak ? `TB ${pts[0]}-${pts[1]}` : `${pts[0]}-${pts[1]}`;
}

/**
 * The score that two integers cannot hold.
 *
 * `home_score`/`away_score` carry sets won, which for tennis is a summary and not
 * the score: 1-1 is true and says almost nothing. What a tennis follower reads is
 * games per set, who is serving, and the points in the game being played -- and the
 * provider sends all three on every poll. They used to stop here, at the adapter
 * boundary, which is how the site ended up with the better provider and an
 * ESPN-shaped scoreboard.
 *
 * Two rules about what survives the end of a match:
 *
 *   * `games` is kept whatever the state. Per-set games IS the result of a tennis
 *     match -- "6-4 4-6 7-5" is the thing anyone quotes afterwards -- so a finished
 *     row keeps it.
 *   * `points` and `serving` are kept only while it is being played. A finished
 *     match's last points reads "0-0", and a server on a court nobody is standing
 *     on is worse than nothing.
 *
 * The array order is [away, home] = [p1, p2], the same mapping the rest of this
 * file uses, so a renderer can zip it against the two sides without knowing which
 * provider it came from.
 */
function scoreDetail(m) {
  const s = m.score;
  const games = Array.isArray(s?.games) ? s.games : null;
  // Two sides or it is not a scoreline this can describe.
  if (!games || games.length !== 2) return null;
  if (!Array.isArray(games[0]) || !Array.isArray(games[1])) return null;
  // A match that has not started sends empty per-set arrays; there is no score to
  // describe yet and an empty grid on a fixture card reads as broken.
  if (games[0].length === 0) return null;

  const live = stateOf(m) === 'in';
  const pts = Array.isArray(s.points) && s.points.length === 2 ? s.points.map(String) : null;

  return {
    kind: 'tennis',
    games,
    points: live ? pts : null,
    tiebreak: live ? s.is_tiebreak === true : false,
    serving: live && (s.server === 1 || s.server === 2) ? (s.server === 1 ? 'away' : 'home') : null,
  };
}

/**
 * A match -> a fixture row.
 *
 * `p1` becomes the AWAY side and `p2` the home side, because the fixture list
 * renders `away vs home` in that order and a tennis card that reads "Sinner vs
 * Alcaraz" must put the same two names in the same two places as the provider did.
 * Neither side is at home, so `neutral_site` is set and the UI drops the H/A tags
 * and says "vs" -- the same treatment ESPN's tennis already gets.
 */
function normaliseMatch(m) {
  const away = side(m.players?.p1);
  const home = side(m.players?.p2);
  if (!away || !home || !m.id || !m.scheduled_time) return null;

  const sets = Array.isArray(m.score?.sets) ? m.score.sets : [];
  // Sets won, which is how a tennis result is quoted. Games per set live in
  // `score.games` and their sum is not a scoreline anyone uses.
  const awayScore = Number.isFinite(sets[0]) ? sets[0] : null;
  const homeScore = Number.isFinite(sets[1]) ? sets[1] : null;

  const tour = tourOf(m);
  const draw = m.is_doubles ? 'doubles' : 'singles';
  const qualifying = m.is_qualifying ? ' (Q)' : '';

  return {
    providerKey: `${name}/${tour}/${m.id}`,
    // Not persisted. Used to settle which copy of a fixture wins when it appears in
    // more than one snapshot -- see the merge in fetchSchedule.
    updatedAt: m.updated_at ? Date.parse(m.updated_at) : 0,
    startsAt: new Date(m.scheduled_time),
    state: stateOf(m),
    statusDetail: statusDetail(m),
    name: `${away.name} v ${home.name}`,
    shortName: null,
    // For tennis the tournament genuinely is the place: a match listed without it
    // is unplaceable, and nobody says "at the Billie Jean King Center".
    venue: m.tournament ?? null,
    // What kind of match it is, which in tennis belongs next to the venue rather
    // than in the name -- a doubles semi-final on clay is three separate facts.
    venueCity:
      [m.round, `${draw}${qualifying}`, m.surface, m.indoor ? 'indoor' : null]
        .filter(Boolean)
        .join(' · ') || null,
    venueRegion: null,
    neutralSite: true,
    // This provider carries no broadcast data. Left null rather than empty so the
    // TheSportsDB pass that fills TV listings still treats these as unfilled.
    broadcast: null,
    broadcastNames: [],
    attendance: null,
    // Which set is being played, which is the tennis reading of a period.
    period: m.score?.games?.[0]?.length ?? null,
    displayClock: displayClock(m),
    scoreDetail: scoreDetail(m),
    home,
    away,
    homeScore,
    awayScore,
    homeRecord: null,
    awayRecord: null,
  };
}

/** How far along a fixture is. A match only ever moves forward through these. */
const PROGRESS = { pre: 0, in: 1, post: 2 };

/**
 * Which copy of a fixture to keep when it turns up in more than one snapshot.
 *
 * It does turn up in more than one, and not for the harmless reason. The three
 * snapshots are refreshed on different clocks -- live every half hour, the others
 * every six -- so at any moment one of them is up to six hours out of date, and
 * "whichever list I read last" is a coin toss rather than an answer. Read that way,
 * a stale live row reinstates `in` on a match that finished hours ago, and it stays
 * there until the next fixture pass: a match on the live page that nobody is
 * playing, which is the exact failure this arrangement exists to avoid.
 *
 * A tennis match only ever moves forward, so the state itself is the tiebreak and
 * it cannot regress. `updated_at` settles the rest, and the order of the lists
 * settles nothing at all -- which is the point.
 */
function wins(next, held) {
  const a = PROGRESS[next.state] ?? 0;
  const b = PROGRESS[held.state] ?? 0;
  if (a !== b) return a > b;
  return next.updatedAt >= held.updatedAt;
}

/*
 * No tournament rows, deliberately -- unlike the ESPN adapter.
 *
 * ESPN stores the tournament itself alongside its matches, for a good reason: its
 * scoreboard lists a fortnight well before the draw exists, so without that row the
 * US Open is invisible until the week it starts, and "Wimbledon" is the thing
 * somebody wants in a calendar rather than "Alcaraz v Sinner, second round".
 *
 * That reason does not survive here. This provider publishes matches about two days
 * out and nothing beyond, so a tournament row synthesised from them cannot exist
 * before the tournament does -- it fails at the one job it was for. What it does
 * instead is three kinds of wrong, all confirmed against the live API:
 *
 *   - It duplicates. `tournament_id` is per DRAW, not per tournament, so
 *     Winston-Salem arrives as t1216 and t1214 and lands twice in one calendar.
 *   - Its start time drifts. The earliest match still inside the window moves
 *     forward every day, so a fortnight-long event keeps announcing that it starts
 *     today.
 *   - It buries the fixtures. ITF returned 48 tournaments against 72 matches; the
 *     calendar becomes mostly headers.
 *
 * Nothing is lost by leaving them out: the tournament name is on every match as its
 * venue, which is where tennis puts it anyway. If a tournament row is wanted later
 * it should come from the provider's own /tournaments endpoint with real dates, not
 * be inferred from a two-day window.
 */

/*
 * ---------------------------------------------------------------------------
 * The adapter surface
 * ---------------------------------------------------------------------------
 */

/**
 * Fixtures for one tour, inside one window.
 *
 * Reads all three snapshots and filters locally. The cost of this call is zero
 * requests whenever another league has already warmed the snapshot in the same
 * pass, which is the point -- see the note at the top of the file.
 *
 * There is no `fetchTeams`: tennis has no roster to ask for. Players arrive as
 * fixture participants, the same path that already covers every league whose teams
 * endpoint 404s, and `syncLeague` handles a missing `fetchTeams` by design.
 */
export async function fetchSchedule({ providerKey, from, to, log = console.warn }) {
  const tour = String(providerKey);
  const [live, upcoming, recent] = await Promise.all([
    snapshot('live', { log }),
    snapshot('upcoming', { log }),
    snapshot('recent', { log }),
  ]);

  const meta = TOURS.find((t) => t.key === tour);

  const byKey = new Map();
  for (const raw of [...recent, ...upcoming, ...live]) {
    if (tourOf(raw) !== tour) continue;
    const m = normaliseMatch(raw);
    if (!m) continue;
    if (m.startsAt < from || m.startsAt > to) continue;
    const held = byKey.get(m.providerKey);
    if (!held || wins(m, held)) byKey.set(m.providerKey, m);
  }

  const matches = [...byKey.values()];

  return {
    league: meta ? { name: meta.name, abbreviation: meta.abbreviation, logoUrl: null } : null,
    events: matches,
  };
}

/*
 * ---------------------------------------------------------------------------
 * The point-by-point log
 * ---------------------------------------------------------------------------
 */

/** match id -> when it was last taped, so the plays rail cannot re-ask every tick. */
const taped = new Map();

/** Ordered so "did the score go up" is a comparison rather than a special case. */
const POINT_ORDER = new Map([
  ['0', 0],
  ['15', 1],
  ['30', 2],
  ['40', 3],
  ['A', 4],
  ['AD', 4],
]);

/**
 * A tiebreak counts in plain numbers, a game counts 15/30/40/AD.
 *
 * Returns null rather than guessing: an unrecognised value must not read as a point
 * going backwards, which is how a log ends up narrating a rally that never happened.
 */
function pointValue(raw, tiebreak) {
  const v = String(raw ?? '').toUpperCase();
  if (tiebreak) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return POINT_ORDER.has(v) ? POINT_ORDER.get(v) : null;
}

const gamesIn = (entry, side) => {
  const g = entry?.games?.[side];
  return Array.isArray(g) ? g.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) : 0;
};

const setsOf = (entry, side) => {
  const s = entry?.sets?.[side];
  return Number.isFinite(s) ? s : 0;
};

/** The set being played, which is how far the per-set list has reached. */
const setNumber = (entry) => entry?.games?.[0]?.length ?? null;

/**
 * Two consecutive tape entries -> what happened between them, in words.
 *
 * The tape is a series of SNAPSHOTS, not a list of described events: each entry is
 * the whole score at a moment. So the narrative is the difference between two of
 * them, read in the order tennis resolves -- a set, else a game, else a point. Read
 * in any other order, the game that wins a set is narrated as an ordinary point.
 *
 * Side 0 is p1, which this adapter renders as the AWAY side, and every score below
 * is written away-home to match the rest of the site.
 */
function describe(prev, cur, names) {
  const set = setNumber(cur);
  const base = {
    providerPlayId: String(cur.timestamp),
    sequence: Number.isFinite(Date.parse(cur.timestamp)) ? Date.parse(cur.timestamp) : null,
    awayScore: setsOf(cur, 0),
    homeScore: setsOf(cur, 1),
    periodNumber: set,
    periodLabel: set ? `Set ${set}` : null,
  };

  // A set. Read first, because the game that won it also moved the game count.
  for (const side of [0, 1]) {
    if (setsOf(cur, side) > setsOf(prev, side)) {
      const finished = prev.games?.[0]?.length ?? set;
      /*
       * The finished set's games are read from `cur`, not from `prev`.
       *
       * The game that wins a set and the set itself land in the SAME tape entry, so
       * `prev` is one game short of the result -- it reported "takes set 1 6-5" for
       * a set won 7-5, which is a wrong scoreline in a permanent record rather than
       * merely a late one. `cur` keeps every completed set in its per-set list
       * (games [[7,3],[5,2]] is 7-5 then 3-2), so the finished set is still there
       * to read after the new one has been appended.
       */
      const a = cur.games?.[0]?.[finished - 1];
      const b = cur.games?.[1]?.[finished - 1];
      const line = Number.isFinite(a) && Number.isFinite(b) ? ` — ${a}-${b}` : '';
      return {
        ...base,
        text: `${names[side]} takes set ${finished}${line}`,
        scoring: true,
        playType: 'set',
      };
    }
  }

  /*
   * More than one game since the last entry, so nobody can be said to have held or
   * broken anything.
   *
   * The tape is sampled rather than exhaustive -- its own meta calls the coverage
   * "partial" -- so two entries can straddle several games. `server` belongs to the
   * FIRST of those games, and spending it on a line that covers four is how a log
   * ends up asserting a break that never happened. The score is still worth saying;
   * the story is not ours to tell.
   */
  const gained = gamesIn(cur, 0) - gamesIn(prev, 0) + (gamesIn(cur, 1) - gamesIn(prev, 1));
  if (gained > 1) {
    const idx = (cur.games?.[0]?.length ?? 1) - 1;
    const a = cur.games?.[0]?.[idx];
    const b = cur.games?.[1]?.[idx];
    return {
      ...base,
      text: Number.isFinite(a) && Number.isFinite(b) ? `Games — ${a}-${b}` : 'Games',
      scoring: true,
      playType: 'games',
    };
  }

  // A game. Whoever was serving is the difference between a hold and a break, which
  // is the single most-read fact in a tennis log.
  for (const side of [0, 1]) {
    if (gamesIn(cur, side) > gamesIn(prev, side)) {
      const server = prev.server === 1 ? 0 : prev.server === 2 ? 1 : null;
      const verb = server === null ? 'wins the game' : server === side ? 'holds' : 'breaks';
      const idx = (cur.games?.[0]?.length ?? 1) - 1;
      const a = cur.games?.[0]?.[idx];
      const b = cur.games?.[1]?.[idx];
      const line = Number.isFinite(a) && Number.isFinite(b) ? ` — ${a}-${b}` : '';
      return {
        ...base,
        text: `${names[side]} ${verb}${line}`,
        scoring: true,
        playType: verb === 'breaks' ? 'break' : 'game',
      };
    }
  }

  // A point, attributed to whichever side's went up. Unreadable on both sides means
  // the tape moved in a way this cannot describe, and saying nothing beats inventing
  // it.
  const tb = cur.is_tiebreak === true;
  for (const side of [0, 1]) {
    const before = pointValue(prev.points?.[side], prev.is_tiebreak === true);
    const after = pointValue(cur.points?.[side], tb);
    if (before === null || after === null) continue;
    if (after > before) {
      const pts = `${cur.points?.[0]}-${cur.points?.[1]}`;
      return {
        ...base,
        text: `${names[side]} — ${tb ? `tiebreak ${pts}` : pts}`,
        scoring: false,
        playType: tb ? 'tiebreak-point' : 'point',
      };
    }
  }

  return null;
}

/**
 * The whole match so far, as a play-by-play log.
 *
 * `/history/matches/{id}` answers for a match that is still being played -- verified
 * against a live Challenger match: 85 entries, the last one seconds old -- and it
 * returns the tape from the FIRST point rather than a slice. That shape is the only
 * reason a log is affordable here: one request is the complete match, so a low poll
 * rate costs lateness rather than missing points, and the read after a match ends
 * leaves a permanent, whole record.
 *
 * Three gates, cheapest first, because the point of each is to avoid a request:
 *
 *   1. The tour has to be one we tape at all. ITF is most of the calendar by volume
 *      and the least of the interest; taping it would spend the day on matches
 *      nobody opened.
 *   2. The match must not have been taped recently. The plays rail asks every two
 *      minutes, and at one request per match that alone is 700 a day.
 *   3. The tape's own sub-budget must have something left, and it can never reach
 *      into the scores' -- a log is worth having, and not at the price of the
 *      scoreboard every fixture depends on.
 *
 * Returns [] rather than throwing on every refusal, upstream failures included: the
 * caller stamps the row and moves on, which is right for something that is an
 * addition to a fixture rather than the fixture itself.
 */
export async function fetchPlays(leagueKey, eventProviderKey, { log = console.warn } = {}) {
  const cfg = config.sports.livetennis;
  const tour = String(leagueKey ?? '').toLowerCase();
  if (!cfg.tapeTours.includes(tour)) return [];

  const id = String(eventProviderKey ?? '')
    .split('/')
    .pop();
  if (!id) return [];

  const last = taped.get(id) ?? 0;
  if (Date.now() - last < cfg.tapeMinIntervalSeconds * 1000) return [];
  if (spend.tape >= cfg.tapeBudget) return [];

  let body;
  try {
    // Stamped BEFORE the await, not after: two overlapping ticks on one match would
    // otherwise both clear the cooldown and both spend a request on it.
    taped.set(id, Date.now());
    body = await getJson(`/history/matches/${id}`, { tape: true });
  } catch (err) {
    log(`[livetennis] tape for ${id} unavailable (${err?.message ?? err})`);
    return [];
  }

  const data = body?.data ?? body;
  const tape = Array.isArray(data?.tape) ? data.tape : [];
  if (tape.length < 2) return [];

  const players = data?.match?.players ?? {};
  const names = [players.p1?.name ?? 'Away', players.p2?.name ?? 'Home'];

  const out = [];
  for (let i = 1; i < tape.length; i++) {
    if (!tape[i]?.timestamp) continue;
    const play = describe(tape[i - 1], tape[i], names);
    if (play) out.push(play);
  }
  return out;
}
