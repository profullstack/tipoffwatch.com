/**
 * A team's own broadcast on SiriusXM.
 *
 * For the leagues SiriusXM carries by team -- the American national ones --
 * every game has a home feed and an away feed on channels of their own, named
 * for the team, and they are what a fan wants over the national call. They
 * come and go with the schedule, so they cannot be a list: they are found by
 * searching SiriusXM for the team's name and keeping what actually names it.
 *
 * The search is upstream, on the reader's own session, so it is bounded here:
 * one lookup per team name every few minutes, shared by every reader on the
 * site, because a Broncos feed is the same Broncos feed whoever asks.
 */

import { search } from './session.js';

/**
 * Leagues where a team has a station of its own, by OUR league slug.
 *
 * `<sport>-<espn league id>`, slugified -- `baseball-mlb`, `soccer-usa-1` --
 * which is what the leagues table holds, and not ESPN's bare ids, which is
 * what this list held first and why every league read as "no team feeds".
 * College is in because SiriusXM carries the big conferences by school; MLS
 * because it carries a game-of-the-week by club. Nothing outside the United
 * States, because that is where the team feeds are -- a Premier League club
 * has no SiriusXM channel to find, and searching for one is a wasted call on
 * a reader's session.
 */
export const TEAM_RADIO_LEAGUES = new Set([
  'football-nfl',
  'basketball-nba',
  'baseball-mlb',
  'hockey-nhl',
  'basketball-wnba',
  'football-college-football',
  'basketball-mens-college-basketball',
  'basketball-womens-college-basketball',
  'soccer-usa-1',
]);

export const hasTeamRadio = (leagueSlug) => TEAM_RADIO_LEAGUES.has(String(leagueSlug ?? ''));

/** Suffixes that are not a nickname. "Inter Miami CF" is not nicknamed "CF". */
const NOT_A_NICKNAME = new Set(['fc', 'sc', 'cf', 'afc', 'united']);

const fold = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The names a team goes by, from what the provider gives us.
 *
 * `nickname` is the provider's own short name when we have it ("Broncos",
 * "Crimson Tide") and the last word of the display name otherwise; `place` is
 * what is left ("Denver", "Alabama"). A college feed is usually named for the
 * school rather than the mascot, so both halves matter.
 *
 * @param {{display_name?: string, name?: string}|string} team
 */
export function teamTerms(team) {
  const display = typeof team === 'string' ? team : (team?.display_name ?? team?.name ?? '');
  const provided = typeof team === 'string' ? '' : (team?.name ?? '');
  const full = fold(display);
  const words = full.split(' ').filter(Boolean);

  let nickname = fold(provided);
  if (!nickname || nickname === full) {
    const tail = [...words];
    while (tail.length > 1 && NOT_A_NICKNAME.has(tail[tail.length - 1])) tail.pop();
    nickname = tail.length > 1 ? tail[tail.length - 1] : '';
  }
  const place = nickname && full.endsWith(nickname) ? full.slice(0, -nickname.length).trim() : '';
  return { full, nickname, place, display };
}

const hasWord = (haystack, needle) =>
  Boolean(needle) &&
  new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(haystack);

/**
 * How well a channel names a team. 0 is not at all.
 *
 * The full name is the strong signal. A nickname alone is accepted only when
 * it is distinctive enough to be one -- four letters and up, so "Jets" and
 * "Kings" count but a stray "Sox" does not -- and the place alone only for a
 * college, where "Alabama" IS the team on the air.
 */
export function matchesTeam(channel, terms, { college = false } = {}) {
  const text = fold(`${channel?.title ?? ''} ${channel?.description ?? ''}`);
  if (!text) return 0;
  if (terms.full && text.includes(terms.full)) return 3;
  if (terms.nickname.length >= 4 && hasWord(text, terms.nickname)) return 2;
  if (college && terms.place.length >= 4 && hasWord(text, terms.place)) return 1;
  return 0;
}

/*
 * Found stations, by folded team name, for a few minutes. Negative answers are
 * kept too, more briefly: a team with no game today has no feed, and asking
 * SiriusXM again on every page view would be the cost this cache exists to
 * remove.
 */
const HIT_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 3 * 60 * 1000;
const found = new Map();

/**
 * The stations naming one team, best match first.
 *
 * @param {string} userId whose session performs the search
 * @param {{display_name?: string, name?: string}|string} team
 * @param {{college?: boolean}} [opts]
 */
export async function teamStations(userId, team, { college = false } = {}) {
  const terms = teamTerms(team);
  if (!terms.full) return [];
  const key = `${terms.full}|${college ? 'c' : ''}`;
  const hit = found.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.stations;
  if (hit?.pending) return hit.pending;

  const pending = search(userId, terms.display)
    .then((channels) => {
      const stations = channels
        .map((ch) => ({ ch, score: matchesTeam(ch, terms, { college }) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || (a.ch.number ?? 1e9) - (b.ch.number ?? 1e9))
        .map((x) => x.ch);
      found.set(key, {
        stations,
        expiresAt: Date.now() + (stations.length ? HIT_TTL_MS : MISS_TTL_MS),
      });
      return stations;
    })
    .catch((err) => {
      found.delete(key);
      throw err;
    });
  found.set(key, { pending, expiresAt: 0 });
  return pending;
}

const isCollege = (leagueSlug) => /college/.test(String(leagueSlug ?? ''));

/**
 * Both sides of a fixture, each with what SiriusXM has for them.
 *
 * Searched in parallel and settled separately: one side failing must not
 * take the other side's feed off the page. A failure is carried as `error`
 * so the section can say which side it could not ask about.
 *
 * @returns {Promise<Array<{team: string, stations: object[], error?: string}>>}
 */
export async function sidesStations(userId, leagueSlug, sides) {
  const college = isCollege(leagueSlug);
  const results = await Promise.allSettled(
    sides.map((team) => teamStations(userId, team, { college })),
  );
  return sides.map((team, i) => {
    const r = results[i];
    const display = teamTerms(team).display;
    return r.status === 'fulfilled'
      ? { team: display, stations: r.value }
      : { team: display, stations: [], error: r.reason?.message ?? 'SiriusXM did not answer.' };
  });
}

export function _resetTeamCache() {
  found.clear();
}
