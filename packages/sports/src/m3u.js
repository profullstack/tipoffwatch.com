/**
 * Parsing a user's own channel list, and finding tonight's game in it.
 *
 * This is a personal-player feature, not a distribution one: a reader adds the
 * playlist they already subscribe to, and we tell them which of their own channels
 * is carrying a fixture. Nothing here is shared between accounts and nothing is
 * relayed -- the hand-off is a one-channel file the owner opens in the player they
 * already use.
 *
 * The parsing is deliberately forgiving. A real provider playlist is not a clean
 * format: 7,000 entries with a dozen naming conventions, blank titles, stale
 * event slots with last month's date in them, and #EXTINF lines that carry either
 * key="value" attributes or nothing at all.
 */

import { normaliseTeam } from './sportsdb.js';

/** Hard ceiling on a stored list. A real one is ~7k lines; this bounds abuse. */
export const MAX_CHANNELS = 20000;

/**
 * Split an M3U into { title, url } pairs.
 *
 * Only `#EXTINF` followed by a URL counts. Everything else -- `#EXTM3U`,
 * `#EXT-X-SESSION-DATA`, comments, blank lines -- is skipped rather than guessed
 * at, because a playlist that half-parses is worse than one that does not.
 *
 * @param {string} text
 */
export function parseM3u(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length && out.length < MAX_CHANNELS; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXTINF')) continue;

    // The title is everything after the LAST comma on the line, because the
    // attribute block before it may itself contain commas inside quotes.
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const title = line.slice(comma + 1).trim();

    // The URL is the next line that is not another directive. Providers sometimes
    // interleave #EXTVLCOPT or #EXTGRP between the two.
    let url = null;
    for (let j = i + 1; j < lines.length; j++) {
      const cand = lines[j].trim();
      if (!cand) continue;
      if (cand.startsWith('#')) continue;
      url = cand;
      i = j;
      break;
    }
    if (!url) continue;

    // A title is optional in the wild -- a numbered slot with nothing on it yet
    // ("NFL 03:") is normal -- but a channel with neither title nor a usable URL
    // is not worth a row.
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ title, url });
  }

  return out;
}

/**
 * Words that carry no identity, so they can never be the reason two things match.
 *
 * Two groups. Broadcast furniture ("hd", "live", "event") appears in thousands of
 * titles; competition furniture ("grand", "prix", "round", "final") appears in
 * every race and would make the Dutch Grand Prix match the Grand Prix of Japan.
 */
const STOP = new Set([
  'hd',
  'fhd',
  'sd',
  'uhd',
  '4k',
  'tv',
  'live',
  'event',
  'events',
  'sport',
  'sports',
  'channel',
  'feed',
  'main',
  'network',
  'and',
  'the',
  'for',
  'with',
  'from',
  'grand',
  'prix',
  'round',
  'race',
  'final',
  'finals',
  'semi',
  'game',
  'match',
  'day',
]);

/**
 * An unassigned slot, not a channel.
 *
 * Providers park spare capacity as "NFL 03:" with nothing after the colon, or name
 * it outright: BLANK, Temp, Test. There are hundreds, they rank well on a
 * shortest-title tiebreak, and every one of them is dead air.
 */
export function isPlaceholder(title) {
  const t = String(title ?? '').trim();
  if (!t) return true;
  // Everything after the last colon is the actual name on these providers.
  const tail = t.includes(':') ? t.slice(t.lastIndexOf(':') + 1).trim() : t;
  if (!tail) return true;
  return /^(blank|temp|tempo|test|tba|tbd|n\/?a|reserved|placeholder)\b/i.test(tail);
}

/** Significant words of a name, normalised. */
function tokens(s) {
  return normaliseTeam(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/**
 * Whole-word containment against a normalised title.
 *
 * `includes` is not enough: "city" would make Manchester City match Norwich City.
 * Padding both sides means a name matches only at a word boundary.
 */
function hasWhole(normTitle, name) {
  const t = normaliseTeam(name);
  if (t.length < 4) return false;
  return ` ${normTitle} `.includes(` ${t} `);
}

/**
 * Does this channel appear to be carrying this fixture?
 *
 * Kept as the STRICT test -- both full names present -- because it is what the
 * confident tier is built on and what the existing tests pin.
 *
 * @param {string} title @param {string|null} home @param {string|null} away
 */
export function channelMatchesFixture(title, home, away) {
  if (!home || !away) return false;
  const norm = normaliseTeam(title);
  if (!norm) return false;
  return hasWhole(norm, home) && hasWhole(norm, away);
}

/**
 * Words whose whole job is telling apart two clubs that share a place name.
 *
 * This is the guard on loose matching, and it is a heuristic rather than a law.
 * Matching "Manchester United" on the word "manchester" alone makes it match a
 * title reading "Manchester City vs Arsenal" -- the shared word is present, the
 * distinguishing one is not, and the wrong one is. So: if a team was matched on
 * only part of its name, and the title carries one of these words that the team
 * itself does not have, the match is refused.
 *
 * Its limitation, stated plainly: it is a list, so it covers the families it
 * names and no others. It errs towards refusing, which is the right direction --
 * the cost of a miss is a channel not offered, and the cost of a false match is
 * someone opening the wrong game.
 */
const DISCRIMINATORS = new Set([
  'city',
  'united',
  'state',
  'tech',
  'athletic',
  'atletico',
  'real',
  'sporting',
  'county',
  'town',
  'albion',
  'forest',
  'rovers',
  'wanderers',
  'academical',
  'north',
  'south',
  'east',
  'west',
  'central',
  'women',
  'womens',
  'reserves',
  'youth',
  'ii',
  'juniors',
  'blues',
  'reds',
]);

/**
 * Did the title name a DIFFERENT member of this team's family?
 *
 * @param {Set<string>} words tokens of the channel title
 * @param {string} team the full team name
 * @param {string[]} matched which of the team's tokens were found
 */
function contradicts(words, team, matched) {
  const own = tokens(team);
  // A complete match cannot be contradicted -- every word of the name is there.
  if (matched.length >= own.length) return false;
  for (const w of words) {
    if (DISCRIMINATORS.has(w) && !own.includes(w)) return true;
  }
  return false;
}

/**
 * Rank a list against a fixture, in tiers, best first.
 *
 * Full-name matching alone was too strict in one direction and structurally blind
 * in another, and the second one is the bigger hole:
 *
 *   - TOO STRICT: providers abbreviate. Ours are "Real Betis" and "UConn Huskies";
 *     the playlist writes "Betis vs. R. Sociedad" and "UConn vs. Syracuse". Whole
 *     names never appear, so nothing matched even though the game was right there.
 *     Fixed by matching on significant WORDS and requiring each side to be found
 *     by a word the other side did not also supply -- otherwise "Manchester" alone
 *     would satisfy both halves of a Manchester derby.
 *
 *   - BLIND: a race, a fight card and a golf tournament have no two sides at all,
 *     so `home`/`away` are null and the strict test returned false before looking
 *     at anything. Every Formula 1 round, every UFC card and every PGA event could
 *     never match, which is not strictness -- it is a whole shape of fixture the
 *     matcher could not see. Those are matched on the event's own distinctive
 *     words instead.
 *
 * Returns { certain, likely, competition }. The last tier is deliberately NOT
 * presented as "this channel has your game": a 24/7 "F1 TV" channel carries
 * whatever Formula 1 is on, which is worth showing and worth labelling honestly.
 *
 * @param {Array<{title:string,url:string}>} channels
 */
export function rankChannelsForFixture(channels, fixture) {
  const { home, away, eventName, leagueName, leagueAbbr } = fixture ?? {};
  const certain = [];
  const likely = [];
  const competition = [];

  const leagueTokens = new Set([...tokens(leagueName ?? ''), ...tokens(leagueAbbr ?? '')]);
  // A league abbreviation is often two characters ("F1"), which `tokens` drops for
  // being short -- and it is the single most useful word there is for a race.
  const shortAbbr = normaliseTeam(leagueAbbr ?? '').replace(/\s+/g, '');
  if (shortAbbr.length >= 2) leagueTokens.add(shortAbbr);

  for (const c of channels ?? []) {
    const norm = normaliseTeam(c.title);
    if (!norm) continue;
    const words = new Set(norm.split(' '));
    const found = (name) => tokens(name).filter((t) => words.has(t));

    if (home && away) {
      if (channelMatchesFixture(c.title, home, away)) {
        certain.push({ ...c, score: 100 + tokens(home).length + tokens(away).length });
        continue;
      }
      const h = found(home);
      const a = found(away);
      // Each side needs a word of its own. Without this, one shared word -- the
      // "Manchester" in a derby, the "Iowa" in Iowa vs Iowa State -- satisfies both
      // halves and every fixture in that family matches every channel in it.
      const disjoint = h.some((t) => !a.includes(t)) && a.some((t) => !h.includes(t));
      const clean = !contradicts(words, home, h) && !contradicts(words, away, a);
      if (h.length && a.length && disjoint && clean) {
        likely.push({ ...c, score: h.length + a.length });
        continue;
      }
    } else if (eventName) {
      // A one-sided fixture: the race, card or tournament itself. STOP has already
      // removed "grand" and "prix", so what is left is what distinguishes this
      // round from the next one -- "dutch", "zandvoort", "monaco".
      const e = found(eventName);
      if (e.length) {
        certain.push({ ...c, score: 50 + e.length });
        continue;
      }
    }

    // Competition level: the channel is for this series rather than this fixture.
    // Placeholders are dropped rather than ranked, because a provider parks its
    // unassigned slots as "NFL 03:" and "F1: BLANK" and there are hundreds of them
    // -- offering one is offering a dead channel.
    if (
      !isPlaceholder(c.title) &&
      leagueTokens.size &&
      [...leagueTokens].some((t) => words.has(t))
    ) {
      competition.push({ ...c, score: 1 });
    }
  }

  // Score first, then the shorter title: a provider carrying one game on several
  // slots gives the primary the plainest name, and the long ones are regional
  // alternates and replays with a date baked in.
  const rank = (arr) =>
    arr
      .sort((x, y) => y.score - x.score || x.title.length - y.title.length)
      .map(({ score, ...c }) => c);

  return { certain: rank(certain), likely: rank(likely), competition: rank(competition) };
}

/**
 * Flat list of everything that looks like this fixture, best first.
 *
 * Competition-level channels are excluded here: this is the "your game is on
 * these" answer, and a 24/7 series channel is a different claim.
 *
 * @param {Array<{title:string,url:string}>} channels
 */
export function channelsForFixture(channels, fixture) {
  const { certain, likely } = rankChannelsForFixture(channels, fixture);
  return [...certain, ...likely];
}

/**
 * A one-channel playlist, handed back to the person who supplied it.
 *
 * This is the whole playback story and it is deliberately small: their own URL,
 * their own credentials, returned to their own browser, for their own player to
 * open. Nothing is proxied and nothing is transcoded, which also sidesteps the two
 * walls a browser puts in the way -- an http:// source is blocked as mixed content
 * on an https page, and a self-signed upstream certificate is rejected outright.
 * A desktop player has neither restriction.
 */
export function oneChannelM3u({ title, url }) {
  return `#EXTM3U\n#EXTINF:-1,${String(title ?? 'Channel').replace(/[\r\n]+/g, ' ')}\n${url}\n`;
}
