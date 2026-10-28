import { matchesEvent } from '@profullstack/webhooks';

/**
 * What a reader's webhooks hear about, and how it is found.
 *
 * Game state is written by two hot paths -- the sweep's upsertEvents and the
 * minute-by-minute live tick -- and neither knows the state it overwrote, so a
 * transition cannot be caught where it happens without slowing both. This scan
 * runs beside them instead (every 30 s in the worker role): it looks for
 * fixtures in a state worth announcing that somebody with a webhook follows,
 * claims each one in `webhook_marks`, and queues one event per owner.
 *
 * The claim (insert ... on conflict do nothing returning) is what makes each
 * announcement happen once however many scanners run. It is taken before the
 * events are queued, so the worst case is a dropped webhook rather than a
 * duplicate, the same trade the reminders make.
 *
 * Only accounts with an enabled endpoint are ever looked at: the follower join
 * starts from webhook_endpoints, which is tiny, never from follows.
 *
 * Everything takes a pg-style `db` (`query(text, params) -> { rows }`), so the
 * tests run it on PGlite and production on Bun.SQL through pgPool. Lists are
 * passed as JSON text, never as a JS array: Bun.SQL stringifies an array
 * parameter as `a,b`, which no Postgres array cast accepts. And always cast
 * `$n::text::jsonb`, never `$n::jsonb`: Bun.SQL binds a JS string to a jsonb
 * parameter as a JSON *string* ('"[\"1\"]"'), so jsonb_array_elements fails
 * with "cannot extract elements from a scalar". PGlite does not, which is why
 * the smoke run against a real server is what caught it.
 */

/** The events tipoffwatch sends, in the order the settings page lists them. */
export const EVENT_TYPES = ['game.starting', 'game.started', 'game.final', 'line.moved'];

export const EVENT_DESCRIPTIONS = {
  'game.starting': 'A game you follow kicks off within the hour (sent once, about 60 minutes out).',
  'game.started': 'A game you follow has started.',
  'game.final': 'A game you follow has finished, with the final score.',
  'line.moved':
    'The betting line on a game you follow moved before kickoff (spread, total or moneyline).',
};

/**
 * Per account, per event type, per clock hour. Past it the rest of that hour is
 * dropped rather than queued: a reader who follows every league would otherwise
 * be sent hundreds of line moves an hour, and one account must not be able to
 * fill the outbox for everybody else.
 */
export const HOURLY_CAP = {
  'game.starting': 300,
  'game.started': 300,
  'game.final': 300,
  'line.moved': 60,
};

/** Each kind's candidate fixtures: `select ref, event_id` with `e` as events. */
const GAME_POOLS = {
  // Timed fixtures only: a date-only or month-precision fixture has no kickoff to
  // count down to, which is the same rule the reminders follow.
  'game.starting': `e.state = 'pre' and e.time_known
      and e.precision in ('second', 'minute', 'hour')
      and e.starts_at > now() and e.starts_at <= now() + interval '60 minutes'`,
  // Four days, not hours: a golf or tennis "event" is a tournament that is `in`
  // for most of a week. updated_at bounds 'post' to fixtures a sync just wrote,
  // so a webhook added today is not told about last month's results.
  'game.started': `e.state = 'in' and e.starts_at > now() - interval '4 days'`,
  'game.final': `e.state = 'post' and e.starts_at > now() - interval '4 days'
      and e.updated_at > now() - interval '2 hours'`,
};

const poolSql = (kind) =>
  kind === 'line.moved'
    ? // A reading with an earlier one before it: the first reading is where the
      // market opened, not a move. Pre-kickoff only, because a reading recovered
      // after the whistle is a settled number, not a live market.
      `select s.id as ref, s.event_id
         from event_odds_snapshots s
        where s.observed_at > now() - interval '30 minutes'
          and s.captured_state = 'pre'
          and exists (select 1 from event_odds_snapshots p where p.event_id = s.event_id and p.id < s.id)
          and not exists (select 1 from webhook_marks m where m.kind = $1 and m.ref = s.id)`
    : `select e.id as ref, e.id as event_id
         from events e
        where ${GAME_POOLS[kind]}
          and not exists (select 1 from webhook_marks m where m.kind = $1 and m.ref = e.id)`;

/** (ref, event_id, owner) for every owner with an enabled endpoint who follows the fixture. */
const candidatesSql = (kind) => `
  with subs as (
    select distinct w.owner, f.subject_type, f.subject_id
      from webhook_endpoints w
      -- Cast the owner rather than the column, so follows' (user_id, ...) key is
      -- used; the case keeps a malformed owner from failing the whole pass.
      join follows f
        on f.user_id = (case when w.owner ~ '^[0-9a-fA-F-]{36}$' then w.owner::uuid end)
     where w.enabled = 1
  ),
  pool as (${poolSql(kind)}),
  cand as (
    select p.ref, p.event_id, s.owner from pool p join events e on e.id = p.event_id
      join subs s on s.subject_type = 'league' and s.subject_id = e.league_id
    union
    select p.ref, p.event_id, s.owner from pool p join events e on e.id = p.event_id
      join subs s on s.subject_type = 'team' and s.subject_id = e.home_team_id
    union
    select p.ref, p.event_id, s.owner from pool p join events e on e.id = p.event_id
      join subs s on s.subject_type = 'team' and s.subject_id = e.away_team_id
  )
  select ref, event_id, owner from cand order by ref limit $2`;

const GAME_SQL = `
  select e.id, e.name, e.short_name, e.starts_at, e.state, e.status_detail,
         e.home_score, e.away_score, e.venue, e.odds,
         l.slug as league_slug, l.name as league_name, l.sport,
         ht.display_name as home_name, ht.slug as home_slug,
         at.display_name as away_name, at.slug as away_slug
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
   where e.id in (select (jsonb_array_elements_text($1::text::jsonb))::bigint)`;

const LINE_COLS = `observed_at, provider, details, spread, over_under, favorite,
         home_moneyline, away_moneyline, draw_moneyline`;

const LINE_SQL = `
  select s.id, s.event_id, s.${LINE_COLS.replace(/,\s+/g, ', s.')},
         (select row_to_json(p) from (
            select ${LINE_COLS} from event_odds_snapshots o
             where o.event_id = s.event_id and o.id < s.id
             order by o.id desc limit 1) p) as previous
    from event_odds_snapshots s
   where s.id in (select (jsonb_array_elements_text($1::text::jsonb))::bigint)`;

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const numOrNull = (v) => (v == null || v === '' ? null : Number(v));
const parsed = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** A fixture as a webhook carries it. */
export function gamePayload(row, siteUrl) {
  return {
    id: Number(row.id),
    url: `${siteUrl}/events/${row.id}`,
    name: row.name,
    short_name: row.short_name ?? null,
    sport: row.sport,
    league: { slug: row.league_slug, name: row.league_name },
    starts_at: iso(row.starts_at),
    state: row.state,
    status: row.status_detail ?? null,
    venue: row.venue ?? null,
    home: row.home_name
      ? { name: row.home_name, slug: row.home_slug, score: row.home_score ?? null }
      : null,
    away: row.away_name
      ? { name: row.away_name, slug: row.away_slug, score: row.away_score ?? null }
      : null,
  };
}

/** One reading of the line, numbers as numbers (Postgres numeric arrives as text). */
export function linePayload(row) {
  if (!row) return null;
  const r = parsed(row);
  return {
    observed_at: iso(r.observed_at),
    provider: r.provider ?? null,
    details: r.details ?? null,
    spread: numOrNull(r.spread),
    over_under: numOrNull(r.over_under),
    favorite: r.favorite ?? null,
    home_moneyline: numOrNull(r.home_moneyline),
    away_moneyline: numOrNull(r.away_moneyline),
    draw_moneyline: numOrNull(r.draw_moneyline),
  };
}

/** Count one send against the owner's hour; false once the cap is spent. */
async function allowed(db, owner, kind, cap) {
  const { rows } = await db.query(
    `insert into webhook_rate (owner, kind, hour, n) values ($1, $2, date_trunc('hour', now()), 1)
     on conflict (owner, kind, hour) do update set n = webhook_rate.n + 1
     returning n`,
    [owner, kind],
  );
  return Number(rows[0]?.n ?? 0) <= cap;
}

/**
 * One pass over every kind. Returns { [kind]: queued } for the log.
 *
 * `emit(owner, type, data, { subject, id })` is the hub's; `siteUrl` builds the
 * links. `limit` bounds the candidate rows per kind per pass, so a backlog after
 * an outage drains over a few passes instead of in one statement.
 */
export async function scanOnce({
  db,
  emit,
  siteUrl,
  limit = 2000,
  caps = HOURLY_CAP,
  log = () => {},
}) {
  const { rows: endpoints } = await db.query(
    'select owner, events from webhook_endpoints where enabled = 1',
  );
  const out = Object.fromEntries(EVENT_TYPES.map((k) => [k, 0]));
  if (endpoints.length === 0) return out;

  // What each owner's endpoints subscribe to, so an owner none of whose
  // endpoints wants this type costs no claim, no rate count and no emit.
  const patterns = new Map();
  for (const e of endpoints) {
    let list;
    try {
      list = JSON.parse(e.events);
    } catch {
      list = ['*'];
    }
    patterns.set(e.owner, [...(patterns.get(e.owner) ?? []), ...list]);
  }

  for (const kind of EVENT_TYPES) {
    const { rows } = await db.query(candidatesSql(kind), [kind, limit]);
    const wanted = rows.filter((r) => matchesEvent(patterns.get(r.owner) ?? [], kind));
    // Claim every ref the pass saw, wanted or not: a fixture followed only by
    // owners who filtered this type out must not be re-read every 30 seconds.
    const refs = [...new Set(rows.map((r) => String(r.ref)))];
    if (refs.length === 0) continue;
    const { rows: claimed } = await db.query(
      `insert into webhook_marks (kind, ref)
       select $1, (jsonb_array_elements_text($2::text::jsonb))::bigint
       on conflict do nothing returning ref`,
      [kind, JSON.stringify(refs)],
    );
    const mine = new Set(claimed.map((r) => String(r.ref)));
    const todo = wanted.filter((r) => mine.has(String(r.ref)));
    if (todo.length === 0) continue;

    const eventIds = [...new Set(todo.map((r) => String(r.event_id)))];
    const { rows: games } = await db.query(GAME_SQL, [JSON.stringify(eventIds)]);
    const gameById = new Map(games.map((g) => [String(g.id), gamePayload(g, siteUrl)]));
    let lineById = new Map();
    if (kind === 'line.moved') {
      const { rows: lines } = await db.query(LINE_SQL, [JSON.stringify([...mine])]);
      lineById = new Map(lines.map((l) => [String(l.id), l]));
    }

    for (const r of todo) {
      const game = gameById.get(String(r.event_id));
      if (!game) continue;
      let data = { game };
      if (kind === 'line.moved') {
        const l = lineById.get(String(r.ref));
        if (!l) continue;
        data = { game, line: linePayload(l), previous: linePayload(l.previous) };
      }
      if (!(await allowed(db, r.owner, kind, caps[kind] ?? Infinity))) continue;
      try {
        // A stable id per announcement: a receiver that sees one twice (the
        // outbox is at-least-once) dedupes on webhook-id.
        await emit(r.owner, kind, data, { subject: `game:${game.id}`, id: `${kind}:${r.ref}` });
        out[kind]++;
      } catch (err) {
        log(`could not queue ${kind} for ${r.owner}: ${err?.message ?? err}`);
      }
    }
  }
  return out;
}

/** Forget marks and rate rows nothing can need again. */
export async function pruneMarks(db) {
  await db.query(`delete from webhook_marks where created_at < now() - interval '7 days'`);
  await db.query(`delete from webhook_rate where hour < now() - interval '2 days'`);
}
