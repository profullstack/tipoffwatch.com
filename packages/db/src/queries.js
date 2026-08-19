import { sql } from './index.js';

/**
 * Every query the app runs lives here. Route handlers and workers import from this
 * module and never write SQL themselves -- that is what makes a schema change one
 * grep instead of an archaeology dig.
 */

/**
 * A Postgres array literal.
 *
 * Bun's parameter serialiser stringifies a JS array with Array.prototype.toString,
 * so `['internal','hybrid']` reaches Postgres as `internal,hybrid` and is rejected
 * as a malformed array literal — silently breaking passkey registration, saving
 * reminder preferences, and the reminder fan-out's user lookup. Building the
 * literal here and casting at the call site is deterministic and does not depend
 * on how the driver decides to encode a parameter.
 */
export function pgArray(values) {
  const items = (values ?? []).map((v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`);
  return `{${items.join(',')}}`;
}

/* ---------------------------------------------------------------- accounts -- */

/**
 * Magic-link consumption creates the account if the address is new. There is no
 * separate registration path: proving you can read the mailbox IS the account.
 */
export async function findOrCreateUser(email) {
  const [row] = await sql`
    insert into users ${sql({ email })}
    on conflict (email) do update set last_seen_at = now()
    returning *
  `;
  return row;
}

export async function insertLoginToken({ tokenHash, email, expiresAt }) {
  await sql`insert into login_tokens ${sql({ token_hash: tokenHash, email, expires_at: expiresAt })}`;
}

/** Spent on first use -- the update is the guard, so a replayed link is inert. */
export async function consumeLoginToken(tokenHash) {
  const [row] = await sql`
    update login_tokens set consumed_at = now()
    where token_hash = ${tokenHash} and consumed_at is null and expires_at > now()
    returning email
  `;
  return row?.email ?? null;
}

export async function startSession({ userId, ttlDays, userAgent }) {
  const [row] = await sql`
    insert into sessions (user_id, expires_at, user_agent)
    values (${userId}, now() + ${`${ttlDays} days`}::interval, ${userAgent ?? null})
    returning id
  `;
  return row.id;
}

export async function getSessionUser(sessionId) {
  const [row] = await sql`
    select u.* from sessions s
    join users u on u.id = s.user_id
    where s.id = ${sessionId} and s.expires_at > now()
  `;
  return row ?? null;
}

export async function endSession(sessionId) {
  await sql`delete from sessions where id = ${sessionId}`;
}

/* ---------------------------------------------------------------- passkeys -- */

export async function insertPasskey({ credentialId, userId, publicKey, counter, transports }) {
  await sql`
    insert into passkeys (credential_id, user_id, public_key, counter, transports)
    values (${credentialId}, ${userId}, ${publicKey}, ${counter}, ${pgArray(transports)}::text[])
    on conflict (credential_id) do update set
      public_key = excluded.public_key,
      counter = excluded.counter,
      transports = excluded.transports
  `;
}

export async function getPasskey(credentialId) {
  const [row] = await sql`select * from passkeys where credential_id = ${credentialId}`;
  return row ?? null;
}

export async function listPasskeys(userId) {
  return sql`select credential_id, transports, created_at, last_used_at from passkeys where user_id = ${userId}`;
}

export async function touchPasskey(credentialId, counter) {
  await sql`update passkeys set counter = ${counter}, last_used_at = now() where credential_id = ${credentialId}`;
}

/* --------------------------------------------------------------- catalogue -- */

/**
 * Upsert from the catalogue endpoint.
 *
 * Note what is NOT updated: name, abbreviation and logo. The catalogue only knows a
 * league's slug, so it seeds those on insert and must never touch them again --
 * otherwise the daily catalogue sync overwrites "English Premier League" with
 * "eng.1" every night. The scoreboard is the authority for display metadata; see
 * renameLeague.
 */
export async function upsertLeague(league) {
  const [row] = await sql`
    insert into leagues ${sql(league)}
    on conflict (provider, provider_key) do update set
      sport = excluded.sport,
      active = true
    returning *
  `;
  return row;
}

/**
 * How many leagues are still named after their raw slug.
 *
 * A non-zero count means display names have never been backfilled from the
 * scoreboard, which is a reason to sync even when the fixtures themselves are
 * fresh -- otherwise the site shows "eng.1" until something else happens to
 * trigger a sweep.
 */
export async function leaguesMissingRealName() {
  const [row] = await sql`
    select count(*)::int as n from leagues
    where active and name = split_part(provider_key, '/', 2)
  `;
  return row.n;
}

export async function upsertTeams(teams) {
  if (teams.length === 0) return [];
  return sql`
    insert into teams ${sql(teams)}
    on conflict (provider, provider_key) do update set
      name = excluded.name,
      display_name = excluded.display_name,
      abbreviation = excluded.abbreviation,
      logo_url = coalesce(excluded.logo_url, teams.logo_url),
      league_id = coalesce(excluded.league_id, teams.league_id)
    returning id, provider_key
  `;
}

/**
 * Bulk upsert in one statement. A sync touches hundreds of rows per league and the
 * cost is round trips, not rows -- one multi-row insert beats a loop by an order of
 * magnitude, and keeps the whole league's schedule atomically consistent.
 */
export async function upsertEvents(events) {
  if (events.length === 0) return [];
  return sql`
    insert into events ${sql(events)}
    on conflict (provider, provider_key) do update set
      starts_at = excluded.starts_at,
      state = excluded.state,
      status_detail = excluded.status_detail,
      name = excluded.name,
      short_name = excluded.short_name,
      venue = coalesce(excluded.venue, events.venue),
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      updated_at = now()
    returning id, provider_key
  `;
}

export async function listLeagues({ sport = null, limit = 500 } = {}) {
  if (sport) {
    return sql`select * from leagues where active and sport = ${sport} order by priority, name limit ${limit}`;
  }
  return sql`select * from leagues where active order by priority, name limit ${limit}`;
}

export async function listSports() {
  return sql`select sport, count(*)::int as leagues from leagues where active group by sport order by sport`;
}

/** Trigram search over team names, for the follow picker. */
export async function searchTeams(term, limit = 25) {
  return sql`
    select t.id, t.slug, t.display_name, t.logo_url, l.name as league_name, l.sport
    from teams t left join leagues l on l.id = t.league_id
    where t.display_name ilike ${`%${term}%`}
    order by similarity(t.display_name, ${term}) desc
    limit ${limit}
  `;
}

/* ----------------------------------------------------------------- follows -- */

export async function addFollow({ userId, subjectType, subjectId }) {
  await sql`
    insert into follows ${sql({ user_id: userId, subject_type: subjectType, subject_id: subjectId })}
    on conflict do nothing
  `;
}

export async function removeFollow({ userId, subjectType, subjectId }) {
  await sql`delete from follows where user_id = ${userId} and subject_type = ${subjectType} and subject_id = ${subjectId}`;
}

export async function listFollows(userId) {
  return sql`
    select f.subject_type, f.subject_id,
           coalesce(t.display_name, l.name) as label,
           coalesce(t.logo_url, l.logo_url) as logo_url,
           coalesce(tl.sport, l.sport) as sport
    from follows f
    left join teams t on f.subject_type = 'team' and t.id = f.subject_id
    left join leagues tl on tl.id = t.league_id
    left join leagues l on f.subject_type = 'league' and l.id = f.subject_id
    where f.user_id = ${userId}
    order by label
  `;
}

/* ---------------------------------------------------------------- schedule -- */

/** The signed-in calendar: every upcoming game involving anything the user follows. */
export async function upcomingForUser(userId, { limit = 100 } = {}) {
  return sql`
    select distinct e.*, l.name as league_name, l.sport,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    join follows f on f.user_id = ${userId}
      and (
        (f.subject_type = 'league' and f.subject_id = e.league_id)
        or (f.subject_type = 'team' and f.subject_id in (e.home_team_id, e.away_team_id))
      )
    where e.starts_at > now() - interval '3 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

/** The public calendar, identical for every visitor, so it is cacheable wholesale. */
export async function scheduleForDay({ day, sport = null, limit = 300 }) {
  if (sport) {
    return sql`
      select e.*, l.name as league_name, l.sport,
             ht.display_name as home_name, ht.logo_url as home_logo,
             at.display_name as away_name, at.logo_url as away_logo
      from events e
      join leagues l on l.id = e.league_id
      left join teams ht on ht.id = e.home_team_id
      left join teams at on at.id = e.away_team_id
      where e.starts_at >= ${day}::date and e.starts_at < ${day}::date + interval '1 day'
        and l.sport = ${sport}
      order by e.starts_at limit ${limit}
    `;
  }
  return sql`
    select e.*, l.name as league_name, l.sport,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.starts_at >= ${day}::date and e.starts_at < ${day}::date + interval '1 day'
    order by l.priority, e.starts_at limit ${limit}
  `;
}

export async function getEvent(eventId) {
  const [row] = await sql`
    select e.*, l.name as league_name, l.sport,
           ht.display_name as home_name, at.display_name as away_name
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.id = ${eventId}
  `;
  return row ?? null;
}

/* --------------------------------------------------------------- reminders -- */

/**
 * Events crossing a reminder threshold in this tick.
 *
 * The window is bounded on both sides. The lower bound is what stops a backlog from
 * firing "starts in 1 hour" for games that kicked off twenty minutes ago after the
 * worker has been down -- late reminders are worse than absent ones.
 */
export async function eventsDueForReminder({ offsetMinutes, lookbackSeconds }) {
  return sql`
    select e.id, e.starts_at, e.name, e.short_name, e.league_id
    from events e
    where e.state = 'pre'
      and e.starts_at - (${offsetMinutes} * interval '1 minute') <= now()
      and e.starts_at - (${offsetMinutes} * interval '1 minute') > now() - (${lookbackSeconds} * interval '1 second')
    order by e.starts_at
  `;
}

/**
 * One page of the people to notify about one event, keyset-paginated by user id.
 *
 * Keyset rather than OFFSET on purpose: a popular final can have millions of
 * followers, and OFFSET re-scans everything it skips, so page N gets linearly
 * slower. The `> after` form stays flat, and it cannot repeat or drop a row when
 * a follow is added mid-fan-out.
 */
export async function followersOfEventPage({
  eventId,
  after = '00000000-0000-0000-0000-000000000000',
  limit = 500,
}) {
  return sql`
    select distinct f.user_id
    from events e
    join follows f
      on (f.subject_type = 'league' and f.subject_id = e.league_id)
      or (f.subject_type = 'team' and f.subject_id in (e.home_team_id, e.away_team_id))
    where e.id = ${eventId} and f.user_id > ${after}::uuid
    order by f.user_id
    limit ${limit}
  `;
}

/** Delivery targets for a page of users: their channels and live push endpoints. */
export async function deliveryTargets(userIds) {
  if (userIds.length === 0) return [];
  return sql`
    select u.id as user_id, u.email, u.timezone,
           coalesce(p.channels, '{webpush,email}') as channels,
           coalesce(p.offsets_minutes, '{60,1}') as offsets_minutes,
           coalesce(
             json_agg(json_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth))
               filter (where ps.id is not null and ps.disabled_at is null),
             '[]'
           ) as push_subscriptions
    from users u
    left join reminder_prefs p on p.user_id = u.id
    left join push_subscriptions ps on ps.user_id = u.id and ps.disabled_at is null
    where u.id = any(${pgArray(userIds)}::uuid[])
    group by u.id, p.channels, p.offsets_minutes
  `;
}

/**
 * Claim the right to send, before sending.
 *
 * The database is the arbiter: whichever worker inserts the row first owns that
 * delivery, and a concurrent or duplicated job gets an empty set back and sends
 * nothing. Claiming after the send instead would make every retry a second
 * notification to a real person's phone.
 *
 * The one exception is a delivery that already failed. Without it the claim row
 * from a failed send blocks every retry, so BullMQ's five attempts would re-claim
 * nothing and the reminder would be lost on the first transient push error --
 * retries that exist but cannot do anything. A row already marked `sent` is never
 * re-claimed, so this can resurrect a failure without ever duplicating a success.
 */
export async function claimDeliveries(rows) {
  if (rows.length === 0) return [];
  return sql`
    insert into reminder_deliveries ${sql(rows)}
    on conflict (event_id, user_id, offset_minutes, channel) do update
      set status = 'sent', sent_at = now()
      where reminder_deliveries.status = 'failed'
    returning event_id, user_id, offset_minutes, channel
  `;
}

export async function markDeliveryFailed({ eventId, userId, offsetMinutes, channel }) {
  await sql`
    update reminder_deliveries set status = 'failed'
    where event_id = ${eventId} and user_id = ${userId}
      and offset_minutes = ${offsetMinutes} and channel = ${channel}
  `;
}

/* ------------------------------------------------------------- push subs --- */

export async function savePushSubscription({ userId, endpoint, p256dh, auth }) {
  await sql`
    insert into push_subscriptions ${sql({ user_id: userId, endpoint, p256dh, auth })}
    on conflict (endpoint) do update set
      user_id = excluded.user_id, p256dh = excluded.p256dh,
      auth = excluded.auth, disabled_at = null
  `;
}

/** Called on a 404/410 from the push service: the browser threw the subscription away. */
export async function disablePushSubscription(endpoint) {
  await sql`update push_subscriptions set disabled_at = now() where endpoint = ${endpoint}`;
}

export async function getPrefs(userId) {
  const [row] = await sql`select * from reminder_prefs where user_id = ${userId}`;
  return row ?? null;
}

export async function savePrefs({ userId, offsetsMinutes, channels }) {
  await sql`
    insert into reminder_prefs (user_id, offsets_minutes, channels)
    values (${userId}, ${pgArray(offsetsMinutes)}::int[], ${pgArray(channels)}::text[])
    on conflict (user_id) do update set
      offsets_minutes = excluded.offsets_minutes,
      channels = excluded.channels,
      updated_at = now()
  `;
}

/**
 * Every reminder offset any user has actually chosen, unioned with the defaults.
 *
 * The scanner must look for exactly these thresholds. Scanning only the defaults
 * would silently never fire a custom offset; scanning a fixed wide range would burn
 * a query per minute-value nobody uses.
 */
export async function distinctReminderOffsets(defaults) {
  const rows = await sql`
    select distinct unnest(offsets_minutes) as m from reminder_prefs
  `;
  return [...new Set([...defaults, ...rows.map((r) => r.m)])]
    .filter((m) => m > 0)
    .sort((a, b) => b - a);
}

/** Replace a catalogue slug with the provider's real display name once we see it. */
export async function renameLeague({ id, name, abbreviation, logoUrl }) {
  await sql`
    update leagues set
      name = ${name},
      abbreviation = coalesce(${abbreviation ?? null}, abbreviation),
      logo_url = coalesce(${logoUrl ?? null}, logo_url)
    where id = ${id}
  `;
}

export async function getLeagueBySlug(slug) {
  const [row] = await sql`select * from leagues where slug = ${slug} and active`;
  return row ?? null;
}

/**
 * A league's own upcoming fixtures.
 *
 * Not "today's schedule filtered to this league" -- that was the first cut, and it
 * told anyone visiting a league with no game today that it had no fixtures at all.
 */
export async function upcomingForLeague(leagueId, { limit = 200 } = {}) {
  return sql`
    select e.*, l.name as league_name, l.sport,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.league_id = ${leagueId} and e.starts_at > now() - interval '3 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

/** Counts for the public API index and the about page. */
export async function catalogueStats() {
  const [row] = await sql`
    select
      (select count(*)::int from leagues where active)                as leagues,
      (select count(distinct sport)::int from leagues where active)   as sports,
      (select count(*)::int from teams)                               as teams,
      (select count(*)::int from events where starts_at > now())      as upcoming_events,
      (select max(updated_at) from events)                            as last_sync
  `;
  return row;
}

/** Public API event feed. Bounded and ordered so it cannot be used to scrape the lot. */
export async function publicEvents({ leagueSlug = null, sport = null, from = null, limit = 100 }) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
  return sql`
    select e.id, e.starts_at, e.state, e.status_detail, e.name, e.short_name, e.venue,
           e.home_score, e.away_score,
           l.slug as league, l.name as league_name, l.sport,
           ht.display_name as home, at.display_name as away
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.starts_at > coalesce(${from}::timestamptz, now() - interval '3 hours')
      and (${leagueSlug}::text is null or l.slug = ${leagueSlug})
      and (${sport}::text is null or l.sport = ${sport})
    order by e.starts_at
    limit ${cap}
  `;
}

/** Months that actually contain fixtures, for the sitemap index. */
export async function eventMonths() {
  return sql`
    select to_char(starts_at, 'YYYY-MM') as month, count(*)::int as n, max(updated_at) as lastmod
    from events
    group by 1 order by 1
  `;
}

/** One month of events for a sitemap chunk. Ordered by (starts_at, id): ordering by
 *  the timestamp alone leaves rows stamped in the same bulk write in an undefined
 *  order, and paginating an undefined order can repeat a row in one chunk while
 *  dropping it from another. */
export async function eventsForMonth(month, { limit = 45000, offset = 0 } = {}) {
  return sql`
    select id, updated_at from events
    where to_char(starts_at, 'YYYY-MM') = ${month}
    order by starts_at, id
    limit ${limit} offset ${offset}
  `;
}

/* ------------------------------------------------------- browse + follow -- */

/**
 * Teams in a league, with whether this user already follows each.
 *
 * The follow state is joined rather than fetched separately so the picker can render
 * the right button in one pass; a second round trip per team is what makes a
 * 500-team league page crawl.
 */
export async function teamsForLeague(leagueId, userId = null) {
  return sql`
    select t.id, t.slug, t.display_name, t.logo_url,
           (f.user_id is not null) as following,
           (select count(*)::int from events e
             where (e.home_team_id = t.id or e.away_team_id = t.id)
               and e.starts_at > now()) as upcoming
    from teams t
    left join follows f
      on f.subject_type = 'team' and f.subject_id = t.id and f.user_id = ${userId}::uuid
    where t.league_id = ${leagueId}
    order by t.display_name
  `;
}

export async function getTeamBySlug(slug) {
  const [row] = await sql`
    select t.*, l.name as league_name, l.slug as league_slug, l.sport
    from teams t left join leagues l on l.id = t.league_id
    where t.slug = ${slug}
  `;
  return row ?? null;
}

export async function isFollowing({ userId, subjectType, subjectId }) {
  if (!userId) return false;
  const [row] = await sql`
    select 1 from follows
    where user_id = ${userId} and subject_type = ${subjectType} and subject_id = ${subjectId}
  `;
  return Boolean(row);
}

/** A single team's upcoming fixtures, home or away. */
export async function upcomingForTeam(teamId, { limit = 60 } = {}) {
  return sql`
    select e.*, l.name as league_name, l.sport,
           ht.display_name as home_name, at.display_name as away_name
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where (e.home_team_id = ${teamId} or e.away_team_id = ${teamId})
      and e.starts_at > now() - interval '3 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

/** Remember the viewer's timezone, which is what email reminders are stamped in. */
export async function setUserTimezone(userId, timezone) {
  await sql`update users set timezone = ${timezone} where id = ${userId}`;
}

/** Leagues in a sport, with whether this user follows each. */
export async function leaguesForSport(sport, userId = null) {
  return sql`
    select l.*, (f.user_id is not null) as following
    from leagues l
    left join follows f
      on f.subject_type = 'league' and f.subject_id = l.id and f.user_id = ${userId}::uuid
    where l.active and l.sport = ${sport}
    order by l.priority, l.name
  `;
}

/** Stamp a league as roster-checked, whether or not it had one. */
export async function markRostersSynced(leagueId) {
  await sql`update leagues set rosters_synced_at = now() where id = ${leagueId}`;
}

/** How many active leagues have never had their roster fetched. */
export async function leaguesMissingRosters() {
  const [row] = await sql`
    select count(*)::int as n from leagues where active and rosters_synced_at is null
  `;
  return row.n;
}
