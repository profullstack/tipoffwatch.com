/**
 * ESPN adapter.
 *
 * ESPN publishes an unauthenticated JSON API behind espn.com. It is not documented
 * and carries no SLA, which is exactly why every response is normalised here and
 * persisted in Postgres immediately: the calendar is served from our own tables, so
 * an ESPN outage degrades freshness rather than blanking the site.
 *
 * Two endpoints are used:
 *   sports.core.api.espn.com/v2  -- catalogue (which sports, which leagues)
 *   site.api.espn.com/apis/site  -- scoreboard (the actual fixtures)
 *
 * Verified 2026-08-19: 17 sports, 354 leagues, 216 of them soccer.
 */

import { config } from '@tipoff/config';

const CORE = 'https://sports.core.api.espn.com/v2';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';

/** A scoreboard response caps out around 100 events regardless of `limit`. */
const PAGE_CAP = 100;

export const name = 'espn';

/** Leagues people actually follow, polled ahead of the long tail. */
const PRIORITY = new Map([
  ['nfl', 1],
  ['nba', 1],
  ['mlb', 1],
  ['nhl', 1],
  ['eng.1', 1],
  ['esp.1', 1],
  ['ger.1', 1],
  ['ita.1', 1],
  ['fra.1', 1],
  ['uefa.champions', 1],
  ['fifa.world', 1],
  ['usa.1', 2],
  ['mex.1', 2],
  ['college-football', 2],
  ['mens-college-basketball', 2],
  ['f1', 2],
  ['atp', 3],
  ['wta', 3],
  ['ufc', 3],
]);

/**
 * ESPN filters on User-Agent, and Bun's default is on the wrong side of it.
 *
 * Verified 2026-08-19: no UA, a browser UA, `node-fetch/*`, `Wget/*` and a plain
 * custom app string all get `403 Access Denied` with an HTML body, while `curl/*`,
 * `okhttp/*`, `python-requests/*` and `Go-http-client/*` get JSON. It is an
 * allowlist of recognised API clients, not a bot block.
 *
 * So the UA is curl-prefixed to clear the filter, with our own URL appended so we
 * are still identifiable and contactable rather than pretending to be something we
 * are not. Both halves are load-bearing: drop the prefix and every request 403s,
 * which is silent because the catch below turns it into an empty result.
 */
const USER_AGENT = 'curl/8.5.0 (+https://tipoffwatch.com)';

/**
 * ESPN requests go through the residential proxy whenever one is configured.
 *
 * ESPN blocks datacenter egress: the identical request that returns JSON from a
 * laptop returns 403 Access Denied from Railway, and it silently took production's
 * sync down for two hours. So the proxy is the normal route and stays that way.
 *
 * What is NOT the normal route is the proxy failing as a BILLING account. On
 * 2026-08-24 the plan ran out of bandwidth mid-evening and every request started
 * coming back `402 Bandwidth limit reached. Please upgrade to continue using the
 * proxy.` -- for sixteen hours. Every score froze, and because a frozen score is
 * still a score the site went on presenting yesterday's fixtures as in progress.
 *
 * A blanket direct-first fallback was tried once before and was rightly reverted:
 * a block does not always arrive as a status, so the direct attempt could throw,
 * and every request paid a doomed round trip before the one that worked. This is
 * the narrow version of it, and the difference is which side is at fault:
 *
 *   - 402/407 is the PROXY refusing us, and says nothing about ESPN. Going direct
 *     is strictly better than not going at all.
 *   - 403/429 is ESPN refusing the proxy's exit IP. A datacenter IP fares worse,
 *     so retrying direct would burn a round trip to be blocked again.
 *
 * And it is a circuit breaker rather than a per-request retry, so an exhausted
 * plan costs one doomed BURST per PROXY_COOLDOWN_MS instead of one per request.
 * A burst, not a single probe, and the distinction is worth stating: the score
 * tick fetches its leagues concurrently, so every request already in flight when
 * the first 402 lands has passed the check too. Measured at ten on the first pass
 * after this shipped, then none until the cooldown expires. That is left alone
 * deliberately -- serialising the probe would mean holding every league's fetch
 * behind one request on the happy path, which is a real cost every minute to save
 * ten 68-byte error responses every five.
 *
 * It re-arms itself: when the plan is topped up the next probe succeeds and the
 * proxy is in use again with no deploy.
 */
const PROXY_COOLDOWN_MS = 5 * 60_000;

/** Set while the proxy is known-unusable; the value is when to try it again. */
let proxyBlockedUntil = 0;

/** Statuses that mean the PROXY rejected us, not that ESPN did. */
const PROXY_FAULT = new Set([402, 407]);

/** Visible for tests, and for a caller that wants to force a re-probe. */
export function resetProxyBreaker() {
  proxyBlockedUntil = 0;
}

async function getJson(url, { timeoutMs = 20000, log = console.warn } = {}) {
  const configured = config.sports.proxyUrl;
  const useProxy = Boolean(configured) && Date.now() >= proxyBlockedUntil;

  const attempt = (proxy) =>
    fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      ...(proxy ? { proxy } : {}),
    });

  let res;
  try {
    res = await attempt(useProxy ? configured : null);
  } catch (err) {
    // A proxy that will not even connect is the same class of problem as one that
    // answers 402, and it arrives as a throw rather than a status.
    if (!useProxy) throw err;
    proxyBlockedUntil = Date.now() + PROXY_COOLDOWN_MS;
    log(`[espn] proxy unreachable (${err?.message ?? err}); going direct for 5 minutes`);
    return getJson(url, { timeoutMs, log });
  }

  if (useProxy && PROXY_FAULT.has(res.status)) {
    /*
     * Read the body before discarding it: this is the one message that says which
     * account is out of what, and it is the difference between "top up Webshare"
     * and sixteen hours of guessing.
     */
    const why = await res.text().catch(() => '');
    proxyBlockedUntil = Date.now() + PROXY_COOLDOWN_MS;
    log(`[espn] proxy ${res.status}: ${why.trim().slice(0, 160)} -- going direct for 5 minutes`);
    return getJson(url, { timeoutMs, log });
  }

  if (!res.ok) {
    throw new Error(`espn ${res.status}${useProxy ? ' (via proxy)' : ' (direct)'} ${url}`);
  }
  return res.json();
}

/**
 * Where a league is played, if the provider will say.
 *
 * The country lives ONLY on the core league endpoint, and only for domestic
 * soccer. It is not on the scoreboard -- which would have been free, since that
 * response is fetched anyway -- so this is a request per league, and the caller
 * is expected to spend them a few at a time rather than sweeping 354 a night.
 *
 * Returns null for every non-soccer league and for continental competitions,
 * which is a fact about the provider rather than a failure: see regions.js for
 * what fills the gap.
 */
export async function fetchLeagueRegion(providerKey) {
  const [sport, slug] = String(providerKey).split('/');
  if (!sport || !slug) return null;
  try {
    const j = await getJson(`${CORE}/sports/${sport}/leagues/${slug}`);
    return j?.country?.name ?? null;
  } catch {
    // A league whose detail endpoint 404s still has fixtures and a name. This is
    // decoration; it must never be able to fail a sync.
    return null;
  }
}

/** The `$ref` links carry the slug in the path; parsing it beats a fetch per league. */
const slugFromRef = (ref, segment) => ref.split(`/${segment}/`)[1].split('?')[0];

/**
 * Every sport and league ESPN knows about. Cheap enough (18 requests) to re-run
 * daily, which is how new competitions appear without a deploy.
 */
export async function listLeagues() {
  const sports = (await getJson(`${CORE}/sports?limit=50`)).items.map((i) =>
    slugFromRef(i.$ref, 'sports'),
  );

  const out = [];
  for (const sport of sports) {
    let page;
    try {
      page = await getJson(`${CORE}/sports/${sport}/leagues?limit=1000`);
    } catch {
      // A sport with no leagues (cricket, currently) 404s rather than returning
      // an empty list. Not an error worth failing the whole catalogue over.
      continue;
    }
    for (const item of page.items ?? []) {
      const key = slugFromRef(item.$ref, 'leagues');
      out.push({
        provider: 'espn',
        provider_key: `${sport}/${key}`,
        sport,
        // Underscores are kept distinct from dots on purpose: ESPN ships both
        // `fifa.intercontinental_cup` and `fifa.intercontinental.cup`, and folding
        // both separators to `-` collapses them into one slug that then violates
        // the unique constraint mid-sync.
        slug: `${sport}-${key}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
        name: key,
        abbreviation: null,
        logo_url: null,
        priority: PRIORITY.get(key) ?? 100,
      });
    }
  }
  return out;
}

/**
 * Every team in a league, whether or not it plays soon.
 *
 * The fixture sweep only ever sees teams with a game inside the horizon, so a
 * follow picker built from fixtures alone shows whoever happens to be playing this
 * fortnight -- eight Premier League clubs instead of twenty. This is the roster.
 *
 * Individual sports (tennis, golf, racing) have no teams endpoint and 404 here,
 * which is expected rather than an error.
 */
export async function fetchTeams(providerKey) {
  let data;
  try {
    // Without an explicit limit the teams endpoint returns only the first 50, so
    // college football silently synced 50 of its 759 programmes and the picker was
    // missing most of the league rather than obviously broken.
    data = await getJson(`${SITE}/${providerKey}/teams?limit=1000`);
  } catch {
    return [];
  }

  const entries = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];

  return entries
    .map((entry) => entry.team)
    .filter(Boolean)
    .map((t) => ({
      // Keyed by LEAGUE, not sport. ESPN team ids are only unique within a league:
      // id 7 is the Denver Broncos in the NFL and the Amherst Mammoths in college
      // football, and 20 NFL ids collide with college ones. Keying by sport merged
      // them, so the upsert overwrote the names and the NFL page listed college
      // teams playing each other.
      providerKey: `${providerKey}/${t.id}`,
      name: t.name ?? t.displayName ?? t.shortDisplayName ?? 'Unknown',
      displayName: t.displayName ?? t.name ?? 'Unknown',
      abbreviation: t.abbreviation ?? null,
      logoUrl: t.logos?.[0]?.href ?? t.logo ?? null,
    }));
}

/** 1 -> "1st". Only used when the provider ships no period label of its own. */
const ordinal = (n) => {
  if (!Number.isFinite(n)) return null;
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/**
 * One provider play -> our row shape, or null if it is not usable.
 *
 * Every sport's play object carries the same core fields (`id`, `text`,
 * `scoringPlay`, `period`), which is what makes one mapper enough for the three
 * different containers below.
 */
const normalisePlay = (p, { sequence = null } = {}) => {
  if (!p?.id || !p?.text) return null;

  // Checked for absence before conversion, because Number(null) is 0 -- which would
  // file every unsequenced play at the top of the log rather than leaving it
  // unordered for the id to break.
  const rawSeq = p.sequenceNumber ?? sequence;
  const seq =
    rawSeq === null || rawSeq === undefined || rawSeq === '' ? Number.NaN : Number(rawSeq);
  const periodNumber = Number.isFinite(p.period?.number) ? p.period.number : null;

  // Baseball labels its own periods ("1st Inning") and we use that verbatim.
  // Football ships no label at all -- just a number and a game clock, and expects
  // the caller to phrase it -- so without this fallback every NFL play would render
  // with an empty "when" column.
  const label =
    p.period?.displayValue ??
    [p.clock?.displayValue || null, ordinal(periodNumber)].filter(Boolean).join(' · ');

  return {
    providerPlayId: String(p.id),
    sequence: Number.isFinite(seq) ? seq : null,
    text: String(p.text),
    awayScore: Number.isFinite(p.awayScore) ? p.awayScore : null,
    homeScore: Number.isFinite(p.homeScore) ? p.homeScore : null,
    scoring: Boolean(p.scoringPlay),
    periodNumber,
    periodLabel: label || null,
    playType: p.type?.text ?? null,
  };
};

/**
 * Pull the play list out of a summary, whichever way this sport happens to ship it.
 *
 * There is no single field, and reading only the flat one is why football and soccer
 * fixtures carried no action log at all: the request succeeded and the array was
 * simply absent, which the empty-is-normal path upstream reads as "no plays yet".
 *
 *   - `plays`      baseball, basketball -- flat and already ordered
 *   - `drives`     football -- nested one level under the current and previous drives
 *   - `commentary` soccer -- each entry wraps a play and carries the sequence that
 *                  the play itself lacks; `keyEvents` is the same feed minus the
 *                  filler, and covers matches with no commentary
 *
 * All four are read on every call rather than switched on the sport: the sport is not
 * in scope here, and a league shipping two of them should yield both. Ids repeated
 * across shapes -- every soccer keyEvent also appears in commentary -- collapse to
 * one row, which is also what the unique index downstream expects.
 */
export function playsFromSummary(data) {
  const seen = new Map();
  const add = (play, opts) => {
    const row = normalisePlay(play, opts);
    if (row && !seen.has(row.providerPlayId)) seen.set(row.providerPlayId, row);
  };

  for (const p of data.plays ?? []) add(p);

  // `drives.current` is one drive and `drives.previous` a list -- and a finished game
  // drops `current` altogether, so neither key can be assumed to be there.
  const drives = data.drives;
  const driveList = Array.isArray(drives)
    ? drives
    : [drives?.current, ...(drives?.previous ?? [])].filter(Boolean);
  for (const drive of driveList) {
    for (const p of drive?.plays ?? []) add(p);
  }

  // Commentary holds the ordering: the play it wraps has an id but no
  // sequenceNumber, so reading keyEvents alone comes back with nothing to sort on.
  for (const entry of data.commentary ?? []) add(entry?.play, { sequence: entry?.sequence });
  for (const p of data.keyEvents ?? []) add(p);

  return [...seen.values()];
}

/**
 * Play-by-play for one fixture.
 *
 * The summary response is ~500KB and carries a boxscore, rosters, odds and news we
 * do not use, so callers must space these out -- see eventsNeedingPlays, which caps
 * and staggers them. There is no smaller endpoint.
 *
 * The provider phrases each play per sport and supplies its own stable id, so both
 * are passed through: rebuilding "Duran homered to right center (388 feet)" from
 * structured fields is not something we could do better.
 */
export async function fetchPlays(providerKey, eventProviderKey) {
  // The event's provider_key is `<sport>/<league>/<id>`; the summary wants the id.
  const eventId = eventProviderKey.split('/').pop();
  if (!eventId) return [];

  let data;
  try {
    data = await getJson(`${SITE}/${providerKey}/summary?event=${encodeURIComponent(eventId)}`);
  } catch {
    // A fixture with no summary yet is normal before first pitch, not an error.
    return [];
  }

  return playsFromSummary(data);
}

/** ESPN's status states are already pre/in/post; anything unknown is treated as pre. */
function normaliseState(competition) {
  const state = competition?.status?.type?.state;
  return state === 'in' || state === 'post' ? state : 'pre';
}

const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * Fixtures for one league across a date window.
 *
 * ESPN answers a whole range in a single request, so a 14-day horizon costs one
 * call per league rather than fourteen. When a response comes back at the cap the
 * window is split and re-fetched, because a truncated response is indistinguishable
 * from a quiet fortnight and would silently drop half a busy league's schedule.
 */
export async function fetchSchedule({ providerKey, from, to, depth = 0 }) {
  const url = `${SITE}/${providerKey}/scoreboard?dates=${yyyymmdd(from)}-${yyyymmdd(to)}&limit=1000`;

  let data;
  try {
    data = await getJson(url);
  } catch (err) {
    // A 404 on a date window means nothing is scheduled inside it, which is the
    // normal state of most leagues most of the year -- in August, college
    // basketball, the NFL regular season and half of Europe are all "missing".
    // The undated scoreboard answers with the NEXT fixtures instead, so an
    // out-of-season league shows its season opener rather than an empty page.
    //
    // Only at the top level: inside the window-splitting recursion a 404 means
    // that half genuinely has nothing, and refetching undated there would drag
    // the same far-future fixtures into every branch.
    if (depth > 0) throw err;
    data = await getJson(`${SITE}/${providerKey}/scoreboard`);
  }

  const events = data.events ?? [];

  // The scoreboard carries the league's real display name, abbreviation and logos.
  // The catalogue endpoint only exposes the slug, so without this a league is
  // called "eng.1" everywhere instead of "English Premier League" -- and it costs
  // nothing, because this response was being fetched anyway.
  const meta = data.leagues?.[0];
  const league = meta
    ? {
        name: meta.name ?? null,
        abbreviation: meta.abbreviation ?? null,
        logoUrl: meta.logos?.[0]?.href ?? null,
      }
    : null;

  // Only worth splitting a window that is at least two days wide. Below that the
  // halves collapse to the same day and `mid + 1 day` lands past `to`, which
  // renders as a backwards range like `dates=20260831-20260830` -- ESPN answers
  // that with a 400, so the split turned a full page into a failed league.
  const spansMultipleDays = to.getTime() - from.getTime() >= 2 * 86400000;

  if (events.length >= PAGE_CAP && depth < 4 && spansMultipleDays) {
    const mid = new Date((from.getTime() + to.getTime()) / 2);
    const dayAfterMid = new Date(mid.getTime() + 86400000);
    if (mid > from && dayAfterMid <= to) {
      const [a, b] = await Promise.all([
        fetchSchedule({ providerKey, from, to: mid, depth: depth + 1 }),
        fetchSchedule({ providerKey, from: dayAfterMid, to, depth: depth + 1 }),
      ]);
      const seen = new Set();
      return {
        league: league ?? a.league ?? b.league,
        events: [...a.events, ...b.events].filter(
          (e) => !seen.has(e.providerKey) && seen.add(e.providerKey),
        ),
      };
    }
  }

  return { league, events: events.flatMap((e) => normaliseEntry(e, providerKey)) };
}

function normaliseEvent(e, providerKey) {
  const comp = e.competitions?.[0];
  if (!comp || !e.date) return null;

  const competitors = comp.competitors ?? [];
  const side = (which) => {
    const c = competitors.find((x) => x.homeAway === which);
    if (!c?.team) return null;
    const t = c.team;
    return {
      // Same league scoping as fetchTeams -- these must agree or a fixture's teams
      // will not resolve to the rows the roster created.
      providerKey: `${providerKey}/${t.id}`,
      name: t.name ?? t.displayName ?? t.shortDisplayName ?? 'Unknown',
      displayName: t.displayName ?? t.name ?? 'Unknown',
      abbreviation: t.abbreviation ?? null,
      logoUrl: t.logo ?? t.logos?.[0]?.href ?? null,
      score: c.score === undefined ? null : Number.parseInt(c.score, 10),
      // The first record is the overall season one; later entries are splits
      // (home/away, conference) that mean nothing without their labels.
      record: c.records?.[0]?.summary ?? null,
    };
  };

  const home = side('home');
  const away = side('away');

  // Broadcasters come grouped by market (national / home / away). Flattened and
  // de-duplicated, because "MLB.TV, Tigers.TV" is what a viewer wants to read.
  //
  // Kept as a list as well as a string. The joined form is what the feeds and the
  // legacy column want; the list is what the market picker needs, and splitting the
  // string back apart would be guessing that no broadcaster has a comma in its name.
  const broadcastNames = [...new Set((comp.broadcasts ?? []).flatMap((b) => b.names ?? []))];
  const broadcast = broadcastNames.join(', ') || null;

  return {
    providerKey: `${providerKey}/${e.id}`,
    startsAt: new Date(e.date),
    state: normaliseState(comp),
    statusDetail: comp.status?.type?.shortDetail ?? null,
    name: e.name ?? e.shortName ?? 'Fixture',
    shortName: e.shortName ?? null,
    venue: comp.venue?.fullName ?? null,
    venueCity: comp.venue?.address?.city ?? null,
    // US venues carry a state, everywhere else a country, and never both. One
    // field, because two would leave whichever does not apply permanently null.
    venueRegion: comp.venue?.address?.state ?? comp.venue?.address?.country ?? null,
    // Absent on most leagues and null on soccer, so anything but true is false.
    neutralSite: comp.neutralSite === true,
    broadcast,
    broadcastNames,
    attendance: Number.isFinite(comp.attendance) ? comp.attendance : null,
    period: Number.isFinite(e.status?.period) ? e.status.period : null,
    displayClock: e.status?.displayClock ?? null,
    home,
    away,
    homeScore: Number.isFinite(home?.score) ? home.score : null,
    awayScore: Number.isFinite(away?.score) ? away.score : null,
    homeRecord: home?.record ?? null,
    awayRecord: away?.record ?? null,
  };
}

/**
 * An unfilled bracket slot.
 *
 * A draw is published before it is drawn, so a tournament that has not started
 * carries its full bracket with both sides named "TBD" and a placeholder time at
 * midnight local. Storing those would invent hundreds of "TBD v TBD" fixtures and,
 * worse, a player called TBD that people could follow. The provider marks them with
 * a negative id, which is the one signal here that does not depend on wording.
 */
const isUndrawn = (c) =>
  Number(c?.id) < 0 || (c?.athlete?.displayName ?? c?.roster?.displayName) === 'TBD';

/**
 * One side of a tennis match: a player, or a doubles pair.
 *
 * Singles put the person on `athlete`; doubles put the pairing on `roster` with a
 * composite id ("1652-3970") and both names in one string. Either way it is one
 * side with one key, so a pair is followed as a unit -- which is what a doubles
 * fixture means. The flag stands in for a crest: tennis has no club badge, and a
 * row with no image at all reads as broken rather than as neutral.
 */
const tennisSide = (c, providerKey) => {
  if (!c || isUndrawn(c)) return null;
  const name = c.athlete?.displayName ?? c.roster?.displayName;
  if (!name) return null;

  return {
    providerKey: `${providerKey}/${c.id}`,
    name,
    displayName: name,
    abbreviation: c.athlete?.shortName ?? c.roster?.shortDisplayName ?? null,
    logoUrl: c.athlete?.flag?.href ?? c.roster?.athletes?.[0]?.flag?.href ?? null,
    // Sets won, because that is the score a tennis result is quoted in -- the
    // linescores are games per set, and their sum is not a scoreline anyone uses.
    score: (c.linescores ?? []).length ? c.linescores.filter((l) => l.winner).length : null,
    record: null,
  };
};

/**
 * Tennis, where a scoreboard "event" is a fortnight rather than a fixture.
 *
 * The tournament is the event and the matches hang off it in `groupings`, one per
 * draw -- mens-singles, womens-doubles, and so on. Read as a team sport it has no
 * `competitions` at all, so every tournament normalised to null and the whole sport
 * stored nothing: two leagues, no players, "No fixtures scheduled" all season.
 *
 * Flattened to one event per match it behaves like everything else: real start
 * times, real opponents, and players that become followable teams through the same
 * path that covers leagues whose roster endpoint 404s. The tournament name goes in
 * `venue` -- for tennis the tournament genuinely is the place, and a match listed
 * without it is unplaceable.
 */
/**
 * Which tour owns a draw.
 *
 * A combined tournament -- Cincinnati, the US Open -- is returned in full by BOTH
 * tour scoreboards, every draw included, so taking each at face value stores every
 * match twice under two different keys and invents a second copy of each player.
 * Tours that do not overlap are already separate: Winston-Salem appears only on the
 * ATP board, the Philly Open only on the WTA one.
 *
 * Mixed doubles names no tour and belongs to both, which is the one case with no
 * right answer. It goes to the ATP so that it lands exactly once; the alternative
 * is the same fifteen slam fixtures listed twice.
 */
const drawBelongsTo = (slug, tour) => {
  if (!slug || (tour !== 'atp' && tour !== 'wta')) return true;
  if (slug.startsWith('womens')) return tour === 'wta';
  return tour === 'atp';
};

function tennisMatches(tournament, providerKey) {
  const out = [];
  const tour = providerKey.split('/').pop();

  for (const draw of tournament.groupings ?? []) {
    if (!drawBelongsTo(draw.grouping?.slug, tour)) continue;
    for (const m of draw.competitions ?? []) {
      if (!m?.id || !m.date) continue;

      const competitors = m.competitors ?? [];
      // homeAway is present on some draws and absent on others; `order` is always
      // there, and 1/2 line up with home/away wherever both appear.
      const pick = (which, ord) =>
        competitors.find((x) => x.homeAway === which) ?? competitors.find((x) => x.order === ord);
      const home = tennisSide(pick('home', 1), providerKey);
      const away = tennisSide(pick('away', 2), providerKey);
      if (!home || !away) continue;

      out.push({
        providerKey: `${providerKey}/${m.id}`,
        startsAt: new Date(m.date),
        state: normaliseState(m),
        statusDetail: m.status?.type?.shortDetail ?? null,
        name: `${away.name} v ${home.name}`,
        shortName:
          away.abbreviation && home.abbreviation
            ? `${away.abbreviation} v ${home.abbreviation}`
            : null,
        venue: tournament.name ?? tournament.shortName ?? null,
        venueCity: [m.venue?.fullName, m.venue?.court].filter(Boolean).join(' · ') || null,
        venueRegion: null,
        // Neither side is at home, which the UI already knows how to render: no
        // home/away tags, and "vs" rather than "at".
        neutralSite: true,
        broadcast:
          [...new Set((m.broadcasts ?? []).flatMap((b) => b.names ?? []))].join(', ') || null,
        broadcastNames: [...new Set((m.broadcasts ?? []).flatMap((b) => b.names ?? []))],
        attendance: null,
        period: Number.isFinite(m.status?.period) ? m.status.period : null,
        displayClock: null,
        home,
        away,
        homeScore: home.score,
        awayScore: away.score,
        homeRecord: null,
        awayRecord: null,
      });
    }
  }

  return out;
}

/**
 * The tournament itself, alongside its matches.
 *
 * A draw is only published a few days out, so a tournament that has not been drawn
 * fans out to nothing -- which left the US Open invisible a week before it started,
 * inside the horizon and with a date, simply because none of its matches had names
 * yet. The tournament is a fixture in its own right: it is the thing someone wants
 * in their calendar before the draw exists, and it is the same shape as a grand prix
 * or a fight card, which this adapter already stores with no competitors at all.
 *
 * A combined tournament lands once per tour. That is two rows for one fortnight, but
 * they sit in different leagues, and an ATP follower looking at the ATP calendar
 * should see it there.
 */
function tennisTournament(t, providerKey) {
  if (!t?.id || !t.date) return null;

  return {
    providerKey: `${providerKey}/${t.id}`,
    startsAt: new Date(t.date),
    state: normaliseState(t),
    statusDetail: t.status?.type?.shortDetail ?? null,
    name: t.name ?? t.shortName ?? 'Tournament',
    shortName: t.shortName ?? null,
    venue: t.venue?.displayName ?? null,
    venueCity: null,
    venueRegion: null,
    neutralSite: true,
    broadcast: null,
    broadcastNames: [],
    attendance: null,
    period: null,
    displayClock: null,
    home: null,
    away: null,
    homeScore: null,
    awayScore: null,
    homeRecord: null,
    awayRecord: null,
  };
}

/**
 * One scoreboard entry -> the fixtures it represents, which is usually itself.
 *
 * Tennis is the exception: its entry is a tournament holding a fortnight of
 * matches, so it fans out into both the tournament and every match in it.
 */
function normaliseEntry(e, providerKey) {
  if (Array.isArray(e?.groupings) && e.groupings.length > 0) {
    const tournament = tennisTournament(e, providerKey);
    return [...(tournament ? [tournament] : []), ...tennisMatches(e, providerKey)];
  }
  const one = normaliseEvent(e, providerKey);
  return one ? [one] : [];
}
