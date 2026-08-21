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
 * Whole-word containment against a normalised title.
 *
 * `includes` is not enough: "city" would make Manchester City match Norwich City,
 * and a short fragment would match half the list. Padding both sides means a name
 * matches only at a word boundary.
 */
function hasTeam(normTitle, team) {
  const t = normaliseTeam(team);
  if (t.length < 4) return false;
  return ` ${normTitle} `.includes(` ${t} `);
}

/**
 * Does this channel appear to be carrying this fixture?
 *
 * BOTH sides must appear. Provider titles use every separator there is --
 * "Raiders vs Texans", "GWS Giants _ Carlton", "Ulster - Cardiff Rugby" -- so
 * rather than trying to split on the right one, the whole title is normalised to
 * words and both team names have to be in it. That makes the separator irrelevant
 * and still rejects a channel that merely mentions one club.
 *
 * @param {string} title @param {string|null} home @param {string|null} away
 */
export function channelMatchesFixture(title, home, away) {
  if (!home || !away) return false;
  const norm = normaliseTeam(title);
  if (!norm) return false;
  return hasTeam(norm, home) && hasTeam(norm, away);
}

/**
 * Every channel in a list that looks like this fixture, best first.
 *
 * "Best" is the shortest title among equals, which is a proxy for the most
 * specific entry: a provider that carries a game on several numbered slots tends
 * to give the primary one the plainest name, and the long ones are regional
 * alternates and replays with dates baked into the title.
 *
 * @param {Array<{title:string,url:string}>} channels
 */
export function channelsForFixture(channels, { home, away }) {
  return (channels ?? [])
    .filter((c) => channelMatchesFixture(c.title, home, away))
    .sort((a, b) => a.title.length - b.title.length);
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
