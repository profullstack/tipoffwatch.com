/**
 * TheSportsDB adapter -- broadcast listings only.
 *
 * This is deliberately NOT a fixture provider. ESPN remains the source of truth for
 * what is being played and when; this fills exactly one hole, which is that ESPN's
 * scoreboard carries US listings and nothing else.
 *
 * Measured against ESPN on 2026-08-21: NFL 16/16 games had a broadcast, college
 * football 25/25, MLB 9/9, MLS 13/13 -- but AFL 0/9, NHL 0/7, NBA 0/1, men's
 * college basketball 0/51, and the Premier League had a listing for the current
 * week and nothing for the following month. Two separate causes, and both matter
 * here: leagues with no US rights holder never get one at all, and the rest are
 * only assigned close to kickoff. TheSportsDB answers the first case directly --
 * for the AFL fixture that prompted this it returns "7 Queensland / Australia",
 * which is correct and is something ESPN will never have.
 *
 * THE FREE KEY RETURNS ONE ROW PER QUERY. Not one page, one row: `d=2026-08-21`
 * returned a single NFL listing, and the same query narrowed by sport returned a
 * single AFL listing. That is a cap on the shared test key rather than a rate
 * limit, so on the default key this pass fills a trickle -- which is why it asks
 * per sport rather than per day, and why `usingFreeKey()` exists for the caller to
 * say so out loud. Set SPORTSDB_API_KEY to a subscriber key to get whole days
 * back; nothing else in this module changes.
 */

import { config } from '@tipoff/config';

const BASE = 'https://www.thesportsdb.com/api/v1/json';

/** The shared test keys, which are the ones subject to the one-row cap above. */
const FREE_KEYS = new Set(['3', '123']);

/**
 * Our sport slugs are ESPN's; TheSportsDB uses its own display names. Only the
 * sports where a listing is plausible are mapped -- an unmapped sport asks for the
 * whole day rather than guessing a name the API would silently return nothing for.
 */
const SPORT_NAMES = new Map([
  ['football', 'American Football'],
  ['basketball', 'Basketball'],
  ['baseball', 'Baseball'],
  ['hockey', 'Ice Hockey'],
  ['soccer', 'Soccer'],
  ['australian-football', 'Australian Football'],
  ['rugby', 'Rugby'],
  ['cricket', 'Cricket'],
  ['mma', 'Fighting'],
  ['tennis', 'Tennis'],
  ['golf', 'Golf'],
  ['motorsport', 'Motorsport'],
  ['racing', 'Motorsport'],
]);

/** @param {string} sport */
export const sportName = (sport) => SPORT_NAMES.get(sport) ?? null;

/**
 * Club suffixes carry no identity: "Collingwood Football Club" and "Collingwood"
 * are the same team, and the two providers disagree about which form to print
 * across most of the catalogue. Stripped before comparison rather than at ingest,
 * because the stored name is what we show people.
 */
const NOISE = /\b(football club|soccer club|athletic club|fc|afc|cf|sc|ac|bk|if|sk|club|the)\b/g;

/** @param {string} s */
export function normaliseTeam(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Do two names refer to the same team?
 *
 * Whole-word containment rather than equality, because the providers routinely
 * disagree on how much of the name to print ("Collingwood" vs "Collingwood Football
 * Club"). Anchoring to a word boundary is what stops that becoming a wildcard:
 * plain `includes` makes Manchester City equal Norwich City on the token "city",
 * and makes every three-letter fragment match half a league.
 *
 * @param {string} a @param {string} b
 */
export function sameTeam(a, b) {
  const x = normaliseTeam(a);
  const y = normaliseTeam(b);
  if (x.length < 4 || y.length < 4) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long.startsWith(`${short} `) || long.endsWith(` ${short}`);
}

/** TheSportsDB titles a fixture "Home vs Away". */
export function splitFixture(title) {
  const parts = String(title ?? '').split(/\s+vs\.?\s+/i);
  return parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : null;
}

/**
 * Every listing that refers to one of our events.
 *
 * Both orderings are tried. ESPN names an event "Away at Home" while TheSportsDB
 * titles it "Home vs Away", and neither is reliable enough across 354 leagues to
 * depend on -- requiring BOTH sides to match means an order mix-up costs nothing
 * while a genuine mismatch is still rejected.
 *
 * Returns an empty array rather than a best guess. A wrong channel is worse than no
 * channel: it is the one field on the page a reader would act on by turning a
 * television on.
 *
 * @param {{home:string|null, away:string|null}} event
 * @param {Array<{event:string, channel:string, country:string|null}>} listings
 */
export function matchListings(event, listings) {
  if (!event.home || !event.away) return [];
  return listings.filter((row) => {
    const pair = splitFixture(row.event);
    if (!pair) return false;
    const [a, b] = pair;
    return (
      (sameTeam(a, event.home) && sameTeam(b, event.away)) ||
      (sameTeam(a, event.away) && sameTeam(b, event.home))
    );
  });
}

/**
 * Group a fixture's listings by market, most-covered first.
 *
 * Several listings for one game is the normal case rather than an edge case: a
 * match is carried in a dozen countries and TheSportsDB returns a row per
 * broadcaster. All of them are kept, because collapsing to one country meant most
 * readers were shown a channel they cannot watch -- and an unlabelled channel is
 * worse than none, since "7 Queensland" is the right answer for an AFL game in
 * Australia and no use at all in Ohio.
 *
 * Ordering is by breadth then name. It decides which market the page opens on for
 * a reader whose own country is not carried, and alphabetical is only a tiebreak so
 * that equal markets do not reshuffle between syncs.
 *
 * @param {Array<{channel:string, country:string|null}>} rows
 * @returns {Array<{country:string, channels:string[]}>}
 */
export function allMarkets(rows) {
  /** @type {Map<string, string[]>} */
  const byCountry = new Map();
  for (const r of rows) {
    if (!r.channel) continue;
    const c = r.country || 'International';
    if (!byCountry.has(c)) byCountry.set(c, []);
    const list = byCountry.get(c);
    if (!list.includes(r.channel)) list.push(r.channel);
  }
  return [...byCountry.entries()]
    .map(([country, channels]) => ({ country, channels }))
    .sort((a, b) => b.channels.length - a.channels.length || a.country.localeCompare(b.country));
}

/**
 * The one market the flat `events.broadcast` column carries.
 *
 * The feeds, the ICS summaries and the reminder emails have nowhere to put a tab
 * strip, so they still get a single answer; the picker reads the full list.
 *
 * @param {Array<{channel:string, country:string|null}>} rows
 * @param {string|null} preferCountry
 */
export function pickMarket(rows, preferCountry = null) {
  const markets = allMarkets(rows);
  if (markets.length === 0) return null;
  return (preferCountry && markets.find((m) => m.country === preferCountry)) || markets[0];
}

async function getJson(url, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', 'user-agent': 'curl/8.5.0 (+https://tipoffwatch.com)' },
  });
  if (!res.ok) throw new Error(`thesportsdb ${res.status} ${url}`);
  return res.json();
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * A day of TV listings, optionally narrowed to one sport.
 *
 * Errors are swallowed into an empty list on purpose. This is a nice-to-have line
 * on a page whose actual job is "when does my team play"; a TheSportsDB outage must
 * degrade the Watch-on-TV row, never fail the sweep that keeps the calendar right.
 */
export async function fetchTvListings({ date, sport = null }) {
  const key = config.sports.sportsDbKey;
  const name = sport ? sportName(sport) : null;
  const url =
    `${BASE}/${encodeURIComponent(key)}/eventstv.php?d=${ymd(date)}` +
    (name ? `&s=${encodeURIComponent(name)}` : '');

  let data;
  try {
    data = await getJson(url);
  } catch {
    return [];
  }

  return (data?.tvevents ?? []).map((r) => ({
    event: r.strEvent ?? '',
    channel: r.strChannel ?? '',
    country: r.strCountry ?? null,
    sport: r.strSport ?? null,
    date: r.dateEvent ?? null,
  }));
}

/** True when running on a shared test key, where a query returns a single row. */
export const usingFreeKey = () => FREE_KEYS.has(config.sports.sportsDbKey);
