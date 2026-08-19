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

async function getJson(url, { timeoutMs = 20000 } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`espn ${res.status} ${url}`);
  return res.json();
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
  const data = await getJson(url);
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

  return { league, events: events.map((e) => normaliseEvent(e, providerKey)).filter(Boolean) };
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
      providerKey: `${providerKey.split('/')[0]}/${t.id}`,
      name: t.name ?? t.displayName ?? t.shortDisplayName ?? 'Unknown',
      displayName: t.displayName ?? t.name ?? 'Unknown',
      abbreviation: t.abbreviation ?? null,
      logoUrl: t.logo ?? t.logos?.[0]?.href ?? null,
      score: c.score === undefined ? null : Number.parseInt(c.score, 10),
    };
  };

  const home = side('home');
  const away = side('away');

  return {
    providerKey: `${providerKey}/${e.id}`,
    startsAt: new Date(e.date),
    state: normaliseState(comp),
    statusDetail: comp.status?.type?.shortDetail ?? null,
    name: e.name ?? e.shortName ?? 'Fixture',
    shortName: e.shortName ?? null,
    venue: comp.venue?.fullName ?? null,
    home,
    away,
    homeScore: Number.isFinite(home?.score) ? home.score : null,
    awayScore: Number.isFinite(away?.score) ? away.score : null,
  };
}
