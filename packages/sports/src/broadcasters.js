/**
 * Reading a broadcaster's name when the provider had no room to write it out.
 *
 * ESPN publishes the carrier of a fixture in a field that is about thirteen
 * characters wide, and it spends them: measured across MLB, NBA, NFL, NHL, WNBA,
 * college football, college basketball and MLS on seven dates, the listings carry
 * "NBC Sports CA", "NBC Sports BA", "NBC Sports BO", "NBC Sports Phil", "USA Net",
 * "ESPN Unlmtd", "Marquee Sports Net" and "Spectrum Sports Net" -- none of which is
 * what the channel calls itself, and none of which a provider list ever writes.
 *
 * A reader's own list writes the whole thing: "USA: NBC Sports California",
 * "USA| MLB NETWORK HD". Matching those demanded every word of the broadcaster be
 * present, so "NBC Sports CA" could not find "NBC Sports California" -- the third
 * word is not there and never will be. The same wall stands in front of every
 * abbreviation in the field, and there are far too many to write down one at a
 * time: the eight above are simply the ones that fell inside one week's fixtures.
 *
 * So this is rules rather than a table. Names are split on their punctuation --
 * "MLB.TV", "Prime Video-Seattle", "Victory+ MIN" -- and compared three ways, each
 * narrower than it looks:
 *
 *   1. GENERIC TAILS. "TV", "Net", "Network" and "Channel" are furniture, not
 *      identity: "MLB.TV" and "MLB Network" are the same three letters plus a word
 *      about what a channel is. Dropped from both sides, what remains has to match
 *      EXACTLY -- so "MLB.TV" finds "MLB Network" and refuses "MLB Extra Innings".
 *
 *   2. ALIGNED ABBREVIATION. Word for word, in order, each one either identical or
 *      a shortening of the one it sits against: "NBC Sports CA" against "NBC Sports
 *      California". At two letters a short form must be a PREFIX ("ca" of
 *      "california", never of "chicago"); from three up it may drop interior letters,
 *      which is what "WSH" and "Unlmtd" need.
 *
 *   3. INITIALISM. One word standing for several: CHSN is Chicago Sports Network,
 *      SNY is SportsNet New York, MASN is Mid-Atlantic Sports Network, FS1 is FOX
 *      Sports 1. The letters are cut into one run per word and every run has to
 *      begin its word. That last requirement is the whole safety of it: "NBC"
 *      cannot be read as "NBC Sports", because "bc" does not begin "sports".
 *
 * All three read the channel's own name with its group prefix removed, for the
 * reason channelMatchesName already does: nearly every US list files its rows under
 * "USA|", and a broadcaster called "USA Net" measured against the whole title would
 * match the entire catalogue.
 */

import { normaliseTeam } from './sportsdb.js';

/** The name is written out in full here, allowing for how a provider spells it. */
export const SPELLED = 2;

/** The initials fit, but they would fit another channel too. */
export const GUESSED = 1;

/**
 * Words that say a thing is a channel, rather than saying which channel it is.
 *
 * The listing and the list disagree about these constantly and mean the same thing
 * by either -- "MLB.TV" and "MLB Network", "USA Net" and "USA Network", "Marquee
 * Sports Net" and "Marquee Sports Network". Deliberately short: "sports" is NOT
 * here and must never be, because NBC Sports is not NBC and the whole point of the
 * matcher is that it knows the difference.
 */
const GENERIC = new Set(['tv', 'net', 'network', 'networks', 'channel']);

/**
 * Words naming another feed of the same channel rather than another channel.
 *
 * Only stripped from the END of a title, so "NBC Sports California East" reduces to
 * the channel while "Mountain West" keeps the word it starts with.
 */
const TRAILING_VARIANT = new Set([
  'east',
  'west',
  'central',
  'mountain',
  'pacific',
  'atlantic',
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

/**
 * "SportsNet" is two words a provider chose not to space.
 *
 * ESPN writes "Spectrum Sports Net" and the list writes "Spectrum SportsNet", which
 * are the same channel and share not one token until the glued word comes apart.
 * Only a generic tail is split off, and only when something is left in front of it,
 * so "Network" itself and "Net" alone survive intact.
 */
function splitGlued(token) {
  for (const g of GENERIC) {
    if (token.length > g.length + 2 && token.endsWith(g)) return [token.slice(0, -g.length), g];
  }
  return [token];
}

/**
 * A name reduced to its words: split on every space, dot, hyphen and plus, with the
 * glued tails opened up and the quality tags dropped from the end.
 *
 * normaliseTeam does the splitting -- it turns anything that is not a letter or a
 * digit into a space -- which is what makes "MLB.TV", "Prime Video-Seattle" and
 * "Victory+ MIN" arrive here as ordinary word lists.
 */
export function broadcastWords(name) {
  const words = normaliseTeam(name).split(' ').filter(Boolean).flatMap(splitGlued);
  let end = words.length;
  while (end > 1 && TRAILING_VARIANT.has(words[end - 1])) end--;
  return words.slice(0, end);
}

/**
 * Is `short` a shortening of `long`?
 *
 * At two letters it has to be a prefix. That is not fussiness: "ca" is a subsequence
 * of "chicago" as well as of "california", and NBC Sports had a station in both
 * cities. A prefix tells them apart and a subsequence does not.
 *
 * From three letters up the interior may drop out -- "wsh" for "washington",
 * "unlmtd" for "unlimited", "mnmt" for "monumental" -- because a skeleton of three
 * letters is how the whole sport writes a city, and by then the letters that remain
 * are enough to carry the name. The first letter always has to survive.
 */
export function shortensTo(short, long) {
  if (!short || !long || short === long || short.length >= long.length) return false;
  if (short[0] !== long[0]) return false;

  /*
   * A whole name with a character or two stuck on the end is the NEXT channel along,
   * not a longer spelling of this one: ESPNU is not ESPN and MASN2 is not MASN, the
   * way TNT Sports 2 is not TNT Sports 1. Spelling a name out adds a word, not a
   * suffix -- "CA" reaches "California" by eight characters and "Net" reaches
   * "Network" by four.
   *
   * Only from three letters up. Below that this is not a name with a suffix on it
   * but a letter or two standing in for a word, which is the ordinary way an
   * initialism is written: "n" for "new", "ba" for "bay".
   */
  if (short.length >= 3 && long.startsWith(short) && long.length - short.length <= 2) return false;

  if (short.length < 3) return long.startsWith(short);

  let i = 0;
  for (const ch of long) {
    if (ch === short[i]) i++;
    if (i === short.length) return true;
  }
  return false;
}

/**
 * Can one word stand for this whole run of words?
 *
 * The letters are cut into as many consecutive runs as there are words, and each
 * run has to shorten the word it lands on -- which means, above all, beginning it.
 * "chsn" over ["chicago", "sports", "network"] cuts to "ch" + "s" + "n"; "nbc" over
 * ["nbc", "sports"] cannot cut at all, because neither "bc" nor "c" begins "sports".
 *
 * Capped at four words. Beyond that the letters are spread so thin that the first
 * letters alone are doing the work, and first letters agree by accident.
 */
export function initialismOf(word, words) {
  if (!word || words.length === 0 || words.length > 4) return false;
  if (word.length < words.length) return false;
  if (words.length === 1) return word === words[0] || shortensTo(word, words[0]);

  const [head, ...rest] = words;
  // Leave at least one letter for every word still to come.
  const most = word.length - rest.length;
  for (let take = 1; take <= most; take++) {
    const chunk = word.slice(0, take);
    if ((chunk === head || shortensTo(chunk, head)) && initialismOf(word.slice(take), rest)) {
      return true;
    }
  }
  return false;
}

/**
 * Word for word, with the last word of the listing allowed to stand for whatever is
 * left of the channel's name -- "NBC Sports BA" against "NBC Sports Bay Area" -- and
 * a listing of one word allowed to stand for all of them, which is the initialism.
 *
 * A lone abbreviation has to be three letters to be read that way. Two letters
 * spread over two or more words is barely a claim at all, and there are enough
 * two-letter channels in a list to make it an expensive one.
 */
function aligns(listed, own) {
  if (listed.length > own.length) return 0;
  for (let i = 0; i < listed.length - 1; i++) {
    if (listed[i] !== own[i] && !shortensTo(listed[i], own[i])) return 0;
  }
  const tail = listed[listed.length - 1];
  const rest = own.slice(listed.length - 1);
  if (listed.length === 1 && rest.length > 1) {
    if (tail.length < 3) return 0;

    /*
     * A channel whose first word IS the whole name is that name followed by other
     * words -- a sub-brand -- and never an initialism of itself. Without this,
     * "CBS" reads "CBS Sports Network" as "cb" + "s", borrowing a letter from the
     * word it had already matched, and the reader is offered CBS Sports for a game
     * on CBS. The pinned refusals -- NBC Sports, Fox Sports 1, CBS Sports Golazo --
     * are all this shape.
     */
    if (rest[0] === tail) return 0;
  }
  if (!initialismOf(tail, rest)) return 0;

  /*
   * How much of a claim this is. An initialism spread over several words is the one
   * reading that can fit two different channels -- MASN is Mid-Atlantic Sports
   * Network and it is also, letter for letter, a way to cut up Marquee Sports
   * Network. When it is exactly the first letter of every word it is the reading the
   * network itself intended; anything looser is a guess, and a guess is only worth
   * offering when nothing better fits. See nameMatchRank.
   */
  if (rest.length === 1) return SPELLED;
  return firstLetters(tail, rest) ? SPELLED : GUESSED;
}

/** Is this exactly the first letter of every word, and nothing else? */
function firstLetters(word, words) {
  return word.length === words.length && words.every((w, i) => w[0] === word[i]);
}

/**
 * Digits standing where letters belong.
 *
 * The Big Ten brands itself B1G, and a provider list writes the channel that way
 * too -- "B1G TEN NETWORK", "B1G+". The same habit produces L1VE and 5PORT5 further
 * down a catalogue. None of it survives a comparison against the words a listing
 * uses, because "b1g" and "big" share no characters where it counts.
 *
 * Only a digit with letters on BOTH sides is read this way. That is the whole guard:
 * a digit on the end is a channel number and means the opposite -- ESPN2 is not
 * ESPN, and expanding its "2" to "two" would make it a longer spelling of it.
 */
const LEET = new Map([
  ['0', 'o'],
  ['1', 'i'],
  ['3', 'e'],
  ['4', 'a'],
  ['5', 's'],
  ['7', 't'],
]);

/** Numbers a channel name says in words as readily as in figures. */
const NUMBER_WORDS = new Map([
  ['1', 'one'],
  ['2', 'two'],
  ['3', 'three'],
  ['4', 'four'],
  ['5', 'five'],
  ['6', 'six'],
  ['7', 'seven'],
  ['8', 'eight'],
  ['9', 'nine'],
  ['10', 'ten'],
  ['11', 'eleven'],
  ['12', 'twelve'],
]);

/** The readings of one word: itself, and whatever its inner digits stand for. */
function letterForms(word) {
  if (!/[a-z]\d+[a-z]/.test(word)) return [word];

  let forms = [''];
  for (const part of word.split(/(\d+)/).filter(Boolean)) {
    const options = /^\d+$/.test(part)
      ? [
          ...new Set(
            [
              [...part].map((d) => LEET.get(d) ?? d).join(''),
              NUMBER_WORDS.get(part) ?? null,
            ].filter(Boolean),
          ),
        ]
      : [part];
    forms = forms.flatMap((f) => options.map((o) => f + o));
  }
  return [...new Set([word, ...forms])];
}

/** Every reading of a name, the one the provider wrote first. Almost always just it. */
function wordForms(words) {
  let out = [[]];
  for (const w of words) {
    const forms = letterForms(w);
    if (forms.length === 1) {
      for (const acc of out) acc.push(forms[0]);
      continue;
    }
    out = out.flatMap((acc) => forms.map((f) => [...acc, f]));
  }
  return out.slice(0, 8);
}

/**
 * Does this channel's own name spell out what the listing abbreviated, and how
 * confidently? SPELLED when the rules leave no room, GUESSED when the reading is one
 * of several a set of initials allows, 0 when nothing fits.
 *
 * @param {string} listedName  the broadcaster, as the provider wrote it
 * @param {string} ownName     the channel's own name, group prefix already removed
 */
export function spellsOut(listedName, ownName) {
  const listed = broadcastWords(listedName);
  const own = broadcastWords(ownName);
  if (listed.length === 0 || own.length === 0) return 0;

  let best = 0;
  for (const l of wordForms(listed)) {
    for (const o of wordForms(own)) {
      best = Math.max(best, compare(l, o));
      if (best === SPELLED) return best;
    }
  }
  return best;
}

/** One reading of the listing against one reading of the channel. */
function compare(listed, own) {
  // Rule 1: the same channel, one side of it saying "TV" and the other "Network".
  const a = listed.filter((w) => !GENERIC.has(w));
  const b = own.filter((w) => !GENERIC.has(w));
  if (a.length > 0 && a.length === b.length && a.every((w, i) => w === b[i])) return SPELLED;

  /*
   * Rules 2 and 3, read against the channel's words as written and again with the
   * "Network" and "TV" taken out. Neither form can be the only one tried: SNY
   * stands for SportsNet New York and needs those words gone to line up three
   * letters against three words, while CHSN stands for Chicago Sports NETWORK and
   * needs the word kept. Trying both costs a comparison and settles it.
   */
  return Math.max(aligns(listed, own), b.length === own.length ? 0 : aligns(listed, b));
}

/**
 * Names ESPN cut off mid-word, and what the channel actually calls itself.
 *
 * Cosmetic only, and nothing depends on it: the matching above finds "NBC Sports
 * California" from "NBC Sports CA" whether or not this map has heard of it. It
 * exists so the page reads the way a viewer's remote does, and a truncation not
 * listed here simply renders as ESPN wrote it. Keyed on the exact string ESPN
 * sends, because "ESPN" and "ESPN+" differ by a character that normalising removes.
 *
 * Not the place for a rebrand. MLB.TV is not renamed to MLB Network here -- they
 * are two different products and the listing means the streaming one -- even though
 * a reader's list carrying MLB Network is offered for it.
 */
const SPELLED_OUT = new Map([
  ['nbc sports ca', 'NBC Sports California'],
  ['nbc sports ba', 'NBC Sports Bay Area'],
  ['nbc sports bo', 'NBC Sports Boston'],
  ['nbc sports phil', 'NBC Sports Philadelphia'],
  ['nbc sports wsh', 'NBC Sports Washington'],
  ['usa net', 'USA Network'],
  ['mlb net', 'MLB Network'],
  ['b1g+', 'Big Ten+'],
  ['espn unlmtd', 'ESPN Unlimited'],
  ['marquee sports net', 'Marquee Sports Network'],
  ['spectrum sports net', 'Spectrum SportsNet'],
  ['rangers sports net', 'Rangers Sports Network'],
]);

/** The broadcaster's own name for itself, where the listing abbreviated it. */
export function canonicalBroadcaster(name) {
  const key = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return SPELLED_OUT.get(key) ?? String(name ?? '').trim();
}
