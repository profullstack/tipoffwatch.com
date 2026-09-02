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

import { spellsOut } from './broadcasters.js';
import { normaliseTeam } from './sportsdb.js';

/*
 * The parsing half now lives in `@profullstack/player/m3u`, and this file keeps
 * the half that is ours: what a channel is CALLED and whether it is carrying
 * tonight's fixture.
 *
 * genrewatch is a port of this repo and read the same playlists with the same
 * code, so the parser existed twice and was fixed twice -- the same reason the
 * codec table moved. And the shared version is streaming, which this one could
 * not be: holding a reader's catalogue as one string, hashing it into a second
 * copy and splitting it into an array of every line is what stopped the sibling
 * site answering, five minutes after every boot.
 *
 * Re-exported rather than re-pointed at every call site, so the existing imports
 * of `parseM3u`/`entryKind`/`MAX_CHANNELS` do not all have to move to say the
 * same thing.
 */
export {
  createM3uParser,
  MAX_CHANNELS,
  parseM3u,
  parseM3uStream,
} from '@profullstack/player/m3u';

// Imported as well as re-exported: `export ... from` creates no local binding, and
// the ranker below calls entryKind for rows stored before the column existed.
import { entryKind } from '@profullstack/player/m3u';

export { entryKind };

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
 * League words that name no league in particular.
 *
 * "Major League Baseball" and "EFL League One" share the word `league`, and that
 * one word was enough to file every English football fixture under a baseball game
 * as a channel "for this competition". The tier is supposed to answer "this
 * carries the series"; `league` answers nothing, and neither do `major`, `cup`,
 * `national` or the sport nouns -- a channel called "Soccer" is not a channel for
 * Major League Soccer.
 *
 * Dropping them does not lose the competitions whose whole name is made of them
 * ("Premier League", "US Open", "Liga MX"), because a contiguous PHRASE of the
 * name is matched alongside its individual words. See leagueSignals.
 */
const GENERIC_LEAGUE = new Set([
  'league',
  'leagues',
  'liga',
  'ligue',
  'lega',
  'serie',
  'division',
  'divisions',
  'conference',
  'championship',
  'championships',
  'cup',
  'trophy',
  'series',
  'major',
  'minor',
  'national',
  'international',
  'association',
  'federation',
  'premier',
  'premiership',
  'professional',
  'pro',
  'first',
  'second',
  'third',
  'world',
  'open',
  'tour',
  'classic',
  'super',
  // Sport nouns. They say what is being played, not which competition it is.
  'football',
  'soccer',
  'basketball',
  'baseball',
  'hockey',
  'cricket',
  'rugby',
  'tennis',
  'golf',
  'boxing',
  'wrestling',
  'volleyball',
  'handball',
  'darts',
  'snooker',
  'cycling',
  'athletics',
  'motorsport',
  'racing',
  'softball',
  'lacrosse',
  'badminton',
  'netball',
]);

/**
 * The sport nouns, on their own.
 *
 * Kept as a second set rather than inferred from GENERIC_LEAGUE because they do
 * one extra job: they are the only words in a title that can positively
 * CONTRADICT a competition. "Major League Soccer" and "Major League Baseball"
 * share the phrase "major league", so the phrase rule alone would offer an MLS
 * fixture under an MLB game; the sport each one names is what separates them.
 *
 * Soccer and football are one entry deliberately -- half the world writes the
 * other word, and a provider titling a Premier League slot "Football" must not be
 * read as naming a different sport from ours.
 */
const SPORT_WORDS = new Set([
  'football',
  'soccer',
  'basketball',
  'baseball',
  'hockey',
  'cricket',
  'rugby',
  'tennis',
  'golf',
  'boxing',
  'wrestling',
  'volleyball',
  'handball',
  'darts',
  'snooker',
  'cycling',
  'athletics',
  'motorsport',
  'racing',
  'softball',
  'lacrosse',
  'badminton',
  'netball',
]);

/** Sport nouns in a name, with soccer folded into football. */
function sportsIn(s) {
  const out = new Set();
  for (const w of normaliseTeam(s).split(' ')) {
    if (SPORT_WORDS.has(w)) out.add(w === 'soccer' ? 'football' : w);
  }
  return out;
}

/**
 * Does this title name a sport, and is it not ours?
 *
 * Only a title that names one at all can contradict: most channel names mention no
 * sport, and silence is not a disagreement. Refusing on a clash is the same
 * direction of error the rest of this file takes -- a channel not offered costs a
 * click, a wrong one costs somebody the game they sat down to watch.
 *
 * @param {Set<string>} ours @param {Set<string>} titleWords
 */
function clashesOnSport(ours, titleWords) {
  if (ours.size === 0) return false;
  let named = false;
  for (const w of titleWords) {
    const s = w === 'soccer' ? 'football' : w;
    if (!SPORT_WORDS.has(s)) continue;
    if (ours.has(s)) return false;
    named = true;
  }
  return named;
}

/**
 * Is this word, or phrase, present in the title as a whole word?
 *
 * Markers arrive normalised already and some are two characters ("F1"), which is
 * below what hasWhole will look at, so this does the padded test directly rather
 * than going through it.
 *
 * @param {string} norm @param {Set<string>} words @param {string} marker
 */
function marksTitle(norm, words, marker) {
  if (!marker) return false;
  return marker.includes(' ') ? ` ${norm} `.includes(` ${marker} `) : words.has(marker);
}

/**
 * Does this title say, in the provider's own tagging, that it is a different
 * competition from ours?
 *
 * This is the guard the loose tier was missing, and the fixture that exposed it is
 * the worst case there is: Baltimore Orioles at St. Louis Cardinals. Matching a
 * word per side is enough for "NFL 07: Baltimore Ravens vs Arizona Cardinals" --
 * `baltimore` for one side, `cardinals` for the other, both present, neither
 * belonging to this game. Nothing in the names themselves can tell those apart,
 * because the names really are shared. The tag can: the line says NFL.
 *
 * Ours wins ties. A title carrying our own marker is never refused on the strength
 * of another one, because providers do write "MLB / NFL Sunday" style groupings,
 * and a title that names our competition has already said what it is.
 *
 * @param {string} norm @param {Set<string>} words
 * @param {string[]} foreign markers belonging to a different sport
 * @param {string[]} ours markers belonging to this fixture
 */
function namesForeignCompetition(norm, words, foreign, ours) {
  if (!foreign?.length) return false;
  if (ours.some((m) => marksTitle(norm, words, m))) return false;
  return foreign.some((m) => marksTitle(norm, words, m));
}

/**
 * What identifies this competition: distinctive words, and phrases of its name.
 *
 * Exported so the candidate query and the ranker ask the same question of a
 * league. Two mechanisms rather than one, because league names come in two kinds:
 *
 *   - Named ones ("Formula 1", "MLB", "Bundesliga") carry a word nothing else
 *     uses, and one shared word is enough. That word is the abbreviation more
 *     often than not, which is why a two-letter one is kept here even though
 *     `tokens` drops it for being short.
 *   - Generic ones ("Premier League", "US Open", "Liga MX") have no such word --
 *     every word in them belongs to fifty other competitions. Those match on a
 *     contiguous phrase of the name instead, which is what a provider writes
 *     anyway: our "English Premier League" against their "PREMIER LEAGUE HD".
 *
 * Short words are kept in the phrases and only in the phrases. "us open" and
 * "liga mx" are made entirely of words `tokens` throws away, so the phrase is the
 * only thing left to match them on.
 *
 * @param {string|null} leagueName @param {string|null} leagueAbbr
 */
export function leagueSignals(leagueName, leagueAbbr) {
  const words = new Set();
  for (const t of [...tokens(leagueName ?? ''), ...tokens(leagueAbbr ?? '')]) {
    if (!GENERIC_LEAGUE.has(t)) words.add(t);
  }
  const short = normaliseTeam(leagueAbbr ?? '').replace(/\s+/g, '');
  if (short.length >= 2 && !GENERIC_LEAGUE.has(short)) words.add(short);

  const phrases = new Set();
  for (const name of [leagueName, leagueAbbr]) {
    const w = normaliseTeam(name ?? '')
      .split(' ')
      .filter(Boolean);
    for (let n = w.length; n >= 2; n--) {
      for (let i = 0; i + n <= w.length; i++) phrases.add(w.slice(i, i + n).join(' '));
    }
  }
  return { words: [...words], phrases: [...phrases] };
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
  for (const name of [home, away, eventName]) {
    if (!name) continue;
    for (const t of tokens(name)) out.add(t);
  }

  /*
   * The league contributes only the words that actually name it.
   *
   * It used to contribute every word of the name, and for "Major League Baseball"
   * two of those are `major` and `league`. On a large list that is catastrophic
   * here rather than merely noisy: the candidate query takes the first 3,000
   * matching rows IN POSITION ORDER, and `%league%` matches every English,
   * Spanish and Champions League fixture the provider carries. The window filled
   * with other sports before it ever reached the row carrying this game -- so the
   * fixture was in the reader's list, and still could not be handed to them,
   * because it never got as far as the ranker.
   */
  const { words, phrases } = leagueSignals(leagueName, leagueAbbr);
  for (const t of [...words, ...phrases]) out.add(t);
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
 * The channel's own name, with the group label its provider filed it under removed.
 *
 * A real list is organised by pipes, colons and spaced dashes -- "USA| NBC HD",
 * "US: NBC EAST", "Sports - TNT" -- and everything before the last separator names
 * the SECTION rather than the channel. isPlaceholder already reads a title this
 * way, for the same reason.
 *
 * This matters most for the country prefix. Nearly every US list files its channels
 * under "USA|", so a broadcaster named "USA" would otherwise match every one of
 * them, which is the worst false positive available here.
 */
function channelName(title) {
  const parts = String(title ?? '')
    .trim()
    .split(/\s*[|:]\s*|\s+-\s+/);
  const last = parts[parts.length - 1].trim();
  return last || String(title ?? '').trim();
}

/**
 * Words that name another feed of the SAME network, rather than another network.
 *
 * "NBC East" and "NBC West" are one broadcaster on two satellites, and a reader
 * looking for a national game is right to be offered either. "Fox Sports 1" is not
 * Fox and "TNT Sports 1" is not TNT, which is why this is a closed list of timezone
 * words and not a general licence to ignore whatever trails the name.
 */
const FEED_VARIANT = new Set([
  'east',
  'west',
  'central',
  'mountain',
  'pacific',
  'atlantic',
  'national',
]);

/**
 * A US broadcast call sign: K west of the Mississippi, W east of it, three to six
 * letters -- WMAQ, KNBC, KPRC, WTVJ, KATNDT. Nothing but a licensed station is
 * shaped like this, which is what makes it worth trusting on its own below.
 */
function isCallSign(t) {
  return /^[kw][a-z]{2,5}$/.test(t);
}

/**
 * Does this word identify a STATION rather than name a different channel?
 *
 * A US network reaches a list as its local affiliates, essentially never as the
 * bare network: the 7,059-entry list this was measured against carries "IL |
 * Chicago | NBC (WMAQ)", "USA: NBC 4 LA (KNBC)" and two dozen more, and no row
 * called simply "NBC". What trails the network name in those is the station --
 * its channel number, its call sign, its city or state -- and all of them are
 * still NBC, so all of them carry a national game.
 *
 * What must NOT survive this test is a sub-brand. The same list carries NBC
 * Sports, NBC News Now, NBC Universo, NBC Golf Pass, NBC Dateline and NBC MakeIt,
 * and none of those is NBC. So this is an allowlist of station shapes rather than
 * a blocklist of brand words: an unrecognised word means "not this network", and
 * a missed affiliate costs a channel while a wrong one sends somebody to the
 * wrong programme.
 *
 * Two characters or fewer is a state or city short form ("LA", "NY", "TX"), which
 * cannot be a brand.
 */
function isStationMark(t) {
  return (
    /^\d{1,3}$/.test(t) ||
    isCallSign(t) ||
    // A subchannel: WPBI-LD2, WGBC-DT3, WOHL-CD2. The dash is gone by the time a
    // title reaches here, so these arrive as their own word.
    /^(ld|dt|cd)\d*$/.test(t) ||
    t.length <= 2
  );
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
 * A short name has to LEAD the channel's own name, and be followed by nothing but
 * that station's own identity. Below four characters the title is read as: group
 * prefix (discarded), then the network, then a channel number, call sign or city
 * -- and anything else at all means this is a sibling brand rather than the
 * network, which is the distinction between "NBC (WMAQ)" and "NBC Sports".
 *
 * That used to be a comparison against the whole title, which was too blunt to ever
 * be reached: it demanded a row called precisely "NBC", and a provider writes "USA|
 * NBC HD". Every three-letter US network -- NBC, CBS, ABC, FOX, TNT, TBS -- was
 * unmatchable in practice while ESPN worked, purely because ESPN has four letters.
 * A reader with NBC on their line was told the game was on NBC and offered nothing.
 *
 * @param {string} channelTitle a title from the reader's own list
 * @param {string} broadcaster  the name a provider gave for this market
 */
export function channelMatchesName(channelTitle, broadcaster) {
  return nameMatchRank(channelTitle, broadcaster) > 0;
}

/** The broadcaster's own words are in the title; nothing had to be worked out. */
export const LITERAL = 3;

/**
 * The same question as channelMatchesName, answered with how sure it is: LITERAL,
 * SPELLED, GUESSED, or 0 for no. Only the ranking uses this -- see
 * marketsWithOwnChannels, where a channel that says the name outright puts out one
 * that merely could be read as it.
 */
export function nameMatchRank(channelTitle, broadcaster) {
  const hay = normaliseTeam(channelTitle);
  const needle = normaliseTeam(broadcaster);
  if (!hay || !needle) return 0;
  if (isPlaceholder(channelTitle)) return 0;
  if (needle.length < 4) {
    const own = nameTokens(channelName(channelTitle)).filter((t) => !FEED_VARIANT.has(t));

    // A country shorthand can lead without a separator behind it to strip -- "US
    // CBS (WGCL) Atlanta" -- so a two-character word ahead of the network is
    // skipped. Never the network itself, or a two-letter one like CW would be
    // skipped past and never found.
    let i = 0;
    while (i < own.length && own[i] !== needle && own[i].length <= 2) i++;

    // The network has to LEAD what is left. "CNBC" and "MSNBC" are their own first
    // word and are not NBC. A name that does not lead is not finished with here --
    // it falls through to the abbreviation rules below, which is how a three-letter
    // initialism like CHSN or SNY finds the name it stands for.
    const rest = own[i] === needle ? own.slice(i + 1) : null;

    /*
     * What follows has to be the station rather than a brand -- or, failing that,
     * has to be vouched for by a call sign.
     *
     * The call sign is the escape hatch and it earns its place: "US CBS (WGCL)
     * Atlanta" and "AK | Fairbanks | ABC (KATNDT)" trail a city we have no list of
     * and cannot recognise, but a four-letter K or W word is a licensed station and
     * essentially nothing else. Sub-brands never carry one, which is why NBC Sports
     * Washington and CBS Sports Golazo Network still fail here.
     */
    if (rest && (rest.every(isStationMark) || rest.some(isCallSign))) return LITERAL;
  } else {
    const words = new Set(nameTokens(channelTitle));
    const own = nameTokens(broadcaster);
    if (own.length > 0 && own.every((t) => words.has(t))) return LITERAL;
  }

  /*
   * Everything above needs the broadcaster's words to actually be in the title, and
   * a provider with thirteen characters to spend does not write them: ESPN files
   * "NBC Sports CA", "MLB.TV", "USA Net", "CHSN". None of those shares a full word
   * with the row a reader's list carries for it. See broadcasters.js -- the last
   * word may stand for the rest, a "TV" and a "Network" are the same claim, and one
   * word may stand for several as long as it begins each of them.
   */
  return spellsOut(broadcaster, channelName(channelTitle));
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
      const ranked = (channels ?? [])
        .map((c) => ({ c, rank: nameMatchRank(c.title, name) }))
        .filter((x) => x.rank > 0);

      /*
       * Only the surest reading of the name is offered.
       *
       * A set of initials can genuinely fit two channels -- MASN is Mid-Atlantic
       * Sports Network and is also, letter for letter, a way to cut up Marquee
       * Sports Network -- and offering both puts the wrong regional in front of a
       * reader who has the right one. So a channel that spells the name out ends
       * any argument with one that merely could be read as it, and only when
       * nothing better fits is a guess worth showing at all.
       */
      const best = Math.max(...ranked.map((x) => x.rank), 0);
      const found = ranked
        .filter((x) => x.rank === best)
        .map((x) => x.c)
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
  const { home, away, eventName, leagueName, leagueAbbr, sport, foreignMarkers } = fixture ?? {};
  const certain = [];
  const likely = [];
  const competition = [];

  const { words: leagueWords, phrases: leaguePhrases } = leagueSignals(leagueName, leagueAbbr);
  // What sport this fixture is, in the title's own vocabulary. The league name
  // usually says it ("Major League Baseball"); the sport column always does, and
  // is the reason it is carried in.
  const ourSports = sportsIn(`${leagueName ?? ''} ${sport ?? ''}`);

  // The tags that mean "not this competition". Supplied by the caller from the
  // leagues table rather than kept as a list here, because the set of leagues is
  // data that changes and a hardcoded copy of it goes stale silently.
  const foreign = (foreignMarkers ?? []).map((m) => normaliseTeam(m)).filter((m) => m.length >= 2);
  const ourMarkers = [normaliseTeam(leagueAbbr ?? ''), ...leagueWords, ...leaguePhrases].filter(
    Boolean,
  );

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
      /*
       * And the title must not have said what it is, if what it said is not this.
       *
       * A word per side is a weak claim, and on shared names it is routinely a
       * false one: Baltimore Orioles at St. Louis Cardinals matched "NFL 07:
       * Baltimore Ravens vs Arizona Cardinals" on `baltimore` and `cardinals`.
       * Both words are there and neither team is. The provider's own tag is the
       * only thing on the line that knows, so it is asked -- but only here, in the
       * loose tier. A title carrying BOTH full names is a match whatever it is
       * tagged, and rejecting that would cost a real game to a provider's typo.
       */
      const ours =
        !clashesOnSport(ourSports, words) &&
        !namesForeignCompetition(norm, words, foreign, ourMarkers);
      if (h.length && a.length && disjoint && clean && ours) {
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

    /*
     * Competition level: the channel is for this series rather than this fixture.
     *
     * The test is "does this title NAME our competition", not "does it share a
     * word with its name". Sharing a word put every EFL fixture under a Major
     * League Baseball game -- both names contain `league`, and that was the whole
     * of the reasoning. A distinctive word ("mlb", "formula") or a contiguous
     * phrase of the name ("premier league") is a claim about which competition
     * this is; a lone generic word is not.
     *
     * Placeholders are dropped rather than ranked, because a provider parks its
     * unassigned slots as "NFL 03:" and "F1: BLANK" and there are hundreds of them
     * -- offering one is offering a dead channel.
     */
    if (isPlaceholder(c.title)) continue;
    const namesLeague =
      leagueWords.some((t) => words.has(t)) ||
      leaguePhrases.some((p) => ` ${norm} `.includes(` ${p} `));
    if (namesLeague && !clashesOnSport(ourSports, words)) {
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
