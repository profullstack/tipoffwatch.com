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

/**
 * Fallback ceiling for callers that do not pass one.
 *
 * The real limit is configuration -- see playlists.maxChannels -- because it had to
 * become a knob: at 20,000 this silently truncated a 300,000-entry VOD catalogue
 * and the reader had no way to tell which entries were missing.
 */
export const MAX_CHANNELS = 300_000;

/**
 * Pull `key="value"` pairs out of the attribute block of an #EXTINF line.
 *
 * Only the block BEFORE the last comma is scanned. Attribute values routinely
 * contain commas ("Sports, US"), which is what made the old first-comma split
 * wrong: it truncated the title of every channel whose group had one in it.
 */
function parseAttrs(head) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const m of head.matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/**
 * What kind of entry this is: a live channel, a film, or an episode of a series.
 *
 * Read off the URL first, because a provider panel encodes it there and is
 * consistent about it -- /live/, /movie/, /series/, or a file extension. The group
 * is the fallback for the lists that do not.
 *
 * The distinction is not cosmetic: a file is available whenever you want it and a
 * channel is a claim about right now, so conflating the two puts a maybe above a
 * certainty in every ranked list.
 */
export function entryKind({ url, group } = {}) {
  const u = String(url ?? '').toLowerCase();
  if (/\/series\//.test(u)) return 'series';
  if (/\/(movie|movies|vod)\//.test(u)) return 'vod';
  if (/\.(mkv|mp4|avi|m4v)(\?|$)/.test(u)) return 'vod';
  if (/\/live\//.test(u) || /\.(ts|m3u8)(\?|$)/.test(u)) return 'live';

  // Nothing in the URL says. Fall back to the group, which usually does.
  const g = String(group ?? '').toLowerCase();
  if (/\b(vod|on ?demand|movies?|films?)\b/.test(g)) return 'vod';
  if (/\b(series|shows?|tv ?shows?)\b/.test(g)) return 'series';
  return 'live';
}

/**
 * Split an M3U into { title, group, url, kind } entries.
 *
 * Only `#EXTINF` followed by a URL counts. Everything else -- `#EXTM3U`,
 * `#EXT-X-SESSION-DATA`, comments, blank lines -- is skipped rather than guessed
 * at, because a playlist that half-parses is worse than one that does not.
 *
 * Ported from the sibling brand, which had already fixed two things here: the
 * title is taken from the LAST comma rather than the first, and `group-title` is
 * kept. The group is what a provider calls the shelf a channel sits on -- "Sports
 * | US", "PPV", "UK Documentary" -- and it is the most useful single string in the
 * file for telling a reader what one of their own entries actually is.
 *
 * @param {string} text
 */
export function parseM3u(text, { max = MAX_CHANNELS } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  /** `#EXTGRP:` is the other way providers state a group; it applies until changed. */
  let currentGroup = null;

  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTGRP:')) {
      currentGroup = line.slice('#EXTGRP:'.length).trim() || null;
      continue;
    }
    if (!line.startsWith('#EXTINF')) continue;

    /*
     * The title is everything after the LAST comma, not the first.
     *
     * The attribute block before it may itself contain commas inside quotes, and
     * on a real provider list it usually does -- group-title="Sports, US" is
     * ordinary. Splitting on the first comma turns every such title into a
     * fragment of its own metadata, which is what this used to do.
     */
    const comma = line.lastIndexOf(',');
    if (comma < 0) continue;
    const head = line.slice(0, comma);
    const title = line.slice(comma + 1).trim();
    const attrs = parseAttrs(head);

    // The URL is the next line that is not another directive. Providers sometimes
    // interleave #EXTVLCOPT or #EXTGRP between the two.
    let url = null;
    for (let j = i + 1; j < lines.length; j++) {
      const cand = lines[j].trim();
      if (!cand) continue;
      if (cand.startsWith('#EXTGRP:')) {
        currentGroup = cand.slice('#EXTGRP:'.length).trim() || currentGroup;
        continue;
      }
      if (cand.startsWith('#')) continue;
      url = cand;
      i = j;
      break;
    }
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;

    // A title is optional in the wild -- a numbered slot with nothing on it yet
    // ("NFL 03:") is normal -- so fall back to tvg-name before giving up.
    const name = title || attrs['tvg-name'] || '';
    if (!name) continue;

    const group = attrs['group-title'] || currentGroup || null;
    out.push({ title: name, group, url, kind: entryKind({ url, group }) });
  }

  return out;
}

/**
 * The distinct groups in a list, largest first.
 *
 * Counts come along because a provider list has a long tail of one-channel groups
 * that are not worth a row on a page.
 *
 * @param {Array<{group: string|null}>} channels
 */
export function groupsOf(channels) {
  const counts = new Map();
  for (const c of channels ?? []) {
    const g = c.group?.trim();
    if (!g) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
 * The words worth asking the database about, for one fixture.
 *
 * Exported so the candidate query and the ranker agree on what "significant"
 * means. They have to: the query narrows a list to rows worth ranking, and a word
 * the ranker would have matched but the query never asked for is a channel the
 * reader is silently not offered.
 *
 * This exists because a list can now be a whole VOD catalogue. At seven thousand
 * entries, loading all of them and normalising each per page view was free. At
 * three hundred thousand it is a third of a second of CPU on every fixture page,
 * for a handful of rows that could have been selected by index.
 */
export function matchTerms({ home, away, eventName, leagueName, leagueAbbr } = {}) {
  const out = new Set();
  for (const name of [home, away, eventName, leagueName, leagueAbbr]) {
    if (!name) continue;
    for (const t of tokens(name)) out.add(t);
  }
  // A league abbreviation is often two characters ("F1"), which tokens() drops for
  // being short -- and it is the single most useful word there is for a race.
  const short = normaliseTeam(leagueAbbr ?? '').replace(/\s+/g, '');
  if (short.length >= 2) out.add(short);
  return [...out];
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
 * Quality and packaging tags, which are the only words a channel NAME may lose.
 *
 * Deliberately not the STOP list above. That one exists for team names, where
 * "sport", "event", "main" and "network" carry no identity -- and for a
 * broadcaster they are the identity: "Sky Sports Main Event" is four words of
 * which STOP would discard three, leaving "sky", which then matches every Sky
 * channel in the list. Using it here was the first version of this function and
 * it offered Sky Sports Football for a game listed on Main Event.
 */
const CHANNEL_NOISE = new Set([
  'hd',
  'fhd',
  'sd',
  'uhd',
  '4k',
  'hevc',
  'h265',
  'h264',
  'raw',
  'vip',
  'backup',
  'alt',
]);

/** A channel or broadcaster name reduced to the words that identify it. */
function nameTokens(s) {
  return normaliseTeam(s)
    .split(' ')
    .filter((t) => t && !CHANNEL_NOISE.has(t));
}

/**
 * Does this channel appear to BE a named broadcaster?
 *
 * A different question from channelMatchesFixture, which asks whether a channel
 * is carrying a particular game. ESPN and TheSportsDB tell us which broadcaster
 * carries a fixture in each country -- "Sky Sports Main Event", "TNT Sports 1",
 * "7 Queensland" -- and until now that was rendered as text and nothing more,
 * even for a reader whose own list has that exact channel in it.
 *
 * Every identifying word of the broadcaster's name has to be present. Looser than
 * that matches far too much: a list with forty Sky channels would offer all of
 * them for a game on one, and the reader is no better off than with plain text.
 *
 * A short name is required whole. "TNT" as a substring appears inside a dozen
 * unrelated titles, so below four characters the normalised title has to equal it.
 *
 * @param {string} channelTitle a title from the reader's own list
 * @param {string} broadcaster  the name a provider gave for this market
 */
export function channelMatchesName(channelTitle, broadcaster) {
  const hay = normaliseTeam(channelTitle);
  const needle = normaliseTeam(broadcaster);
  if (!hay || !needle) return false;
  if (isPlaceholder(channelTitle)) return false;
  if (needle.length < 4) return hay === needle;

  const words = new Set(nameTokens(channelTitle));
  const own = nameTokens(broadcaster);
  if (own.length === 0) return false;

  return own.every((t) => words.has(t));
}

/**
 * Match a market's broadcasters against a reader's own list.
 *
 * Returns the markets unchanged, each channel name paired with whichever of the
 * reader's own entries look like it. A name with no match keeps its place and its
 * text -- the listing is still true, we simply cannot offer it -- which is why
 * this returns a shape rather than a filtered list.
 *
 * @param {Array<{country: string, channels: string[]}>} markets
 * @param {Array<{id: number, title: string, url: string}>} channels the reader's own
 */
export function marketsWithOwnChannels(markets, channels) {
  return (markets ?? []).map((m) => ({
    country: m.country,
    channels: (m.channels ?? []).map((name) => {
      const found = (channels ?? [])
        .filter((c) => channelMatchesName(c.title, name))
        // The plainest title first: a provider carrying one thing on several slots
        // gives the primary the shortest name, and the long ones are regional
        // alternates and replays with a date baked in.
        .sort((a, b) => a.title.length - b.title.length)
        .slice(0, 3);
      return { name, own: found };
    }),
  }));
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
