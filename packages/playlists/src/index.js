import { createHash } from 'node:crypto';
import { open, seal } from '@tipoff/auth';
import { config } from '@tipoff/config';
import * as q from '@tipoff/db/queries';
import {
  MAX_CHANNELS,
  marketsWithOwnChannels,
  normaliseTeam,
  parseM3u,
  rankChannelsForFixture,
} from '@tipoff/sports';

export { firstLiveChannel, probeStream } from './probe.js';
export { claimStreamSlot, openStream, streamSlotsOpen } from './proxy.js';

/**
 * Importing and reading a reader's own channel list.
 *
 * The whole feature is one person's subscription, used by that person. Nothing
 * here takes an id without a user id beside it, nothing is cached across accounts,
 * and the credentials only ever travel back to the account that supplied them.
 */

/**
 * Fetch the list and store it.
 *
 * The fetch happens once at import rather than per page view: a provider list is
 * most of a megabyte, and re-pulling it on every fixture would hammer the reader's
 * own line -- which is the thing that gets a subscription cut off.
 *
 * Errors are recorded against the row rather than thrown at the reader as a stack
 * trace, because every one of them is something they can act on: a typo in the URL,
 * an expired line, a provider that is down.
 */
export async function importPlaylist({ userId, url, label, knownHash = null }) {
  if (!config.playlists.enabled) throw new Error('playlists are not configured');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That does not look like a URL.');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('The list must be an http:// or https:// address.');
  }

  await q.savePlaylist({ userId, label: label || parsed.hostname, sourceUrl: seal(url) });

  let text;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60_000),
      headers: { 'user-agent': 'curl/8.5.0 (+https://tipoffwatch.com)' },
    });
    if (!res.ok) throw new Error(`the provider answered ${res.status}`);

    // Bounded before reading, not after: a wrong URL pointing at something huge
    // should cost one header round trip rather than filling memory.
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > config.playlists.maxBytes) {
      throw new Error(`that list is ${Math.round(len / 1e6)}MB, which is larger than we store`);
    }
    text = await res.text();
    if (text.length > config.playlists.maxBytes) {
      throw new Error('that list is larger than we store');
    }
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'the provider did not respond' : err.message;
    await q.markPlaylistError({ userId, error: message });
    throw new Error(`Could not read that list: ${message}`);
  }

  // Hash the body before parsing it. The provider offers no conditional request --
  // no ETag, no Last-Modified, and If-Modified-Since is answered with a full 200 --
  // so the download cannot be avoided, but the 7,000-row rewrite behind it can.
  // Most polls see a byte-identical file: the numbered event slots are rewritten
  // near kickoff and the other 7,000 entries sit still.
  const contentHash = createHash('sha256').update(text).digest('hex');
  if (knownHash && knownHash === contentHash) {
    await q.markPlaylistFresh({ userId, contentHash, nextAt: nextRefreshAt() });
    return { channels: null, unchanged: true };
  }

  const channels = parseM3u(text).map((c) => ({
    title: c.title,
    // The provider's own group-title, verbatim. Not mapped onto our leagues: every
    // provider names these differently and a wrong mapping is worse than the raw
    // string, which at least matches what the reader sees in their own player.
    groupTitle: c.group ?? null,
    // Worked out once here rather than per read, because the URL it is derived
    // from is sealed at rest -- recomputing it on a page would mean decrypting
    // several thousand rows to look at their paths.
    kind: c.kind ?? null,
    // Sealed individually: each one is the same credential with a channel id on
    // the end, so a leak of any single row is a leak of the line.
    streamUrl: seal(c.url),
    normTitle: normaliseTeam(c.title),
  }));

  if (channels.length === 0) {
    await q.markPlaylistError({ userId, error: 'no channels found in that file' });
    throw new Error('No channels found in that file — is it an M3U playlist?');
  }

  await q.replacePlaylistChannels({ userId, channels });
  await q.markPlaylistFresh({ userId, contentHash, nextAt: nextRefreshAt() });
  return {
    channels: channels.length,
    truncated: channels.length >= MAX_CHANNELS,
    unchanged: false,
  };
}

/**
 * When this list may next be polled.
 *
 * Jittered by up to a quarter of the interval so that a hundred accounts added on
 * the same afternoon do not all fetch on the same tick forever after -- which is
 * the shape of traffic a provider notices.
 */
function nextRefreshAt() {
  const base = config.playlists.refreshMinutes * 60_000;
  return new Date(Date.now() + base + Math.floor(Math.random() * base * 0.25));
}

/** Re-read the stored URL. Same import path, so the same limits apply. */
export async function refreshPlaylist(userId, { knownHash = null } = {}) {
  const row = await q.getPlaylist(userId);
  if (!row) throw new Error('You have not added a list.');
  const url = open(row.source_url);
  if (!url) throw new Error('That stored list could not be read. Please add it again.');
  return importPlaylist({ userId, url, label: row.label, knownHash });
}

/**
 * Poll every list that is due.
 *
 * Sequential rather than concurrent, deliberately. These are other people's
 * subscriptions and the file is ~800KB each; pulling a dozen at once from one
 * datacenter IP is exactly the traffic pattern that gets a line cut off. One at a
 * time is slower and invisible, which is the correct trade for a background job.
 */
export async function refreshDuePlaylists({ log = console.log, limit = 25 } = {}) {
  const due = await q.playlistsDueForRefresh({ limit });
  if (due.length === 0) {
    /*
     * Say so out loud, rather than returning in silence.
     *
     * This tick logged nothing at all when there was nothing due, which made a
     * poller that was idle indistinguishable from a poller that was never
     * registered -- and that is exactly the question asked of it: "is the
     * five-minute refresh actually running?" could not be answered from the logs,
     * because the healthy state and the broken state both printed nothing.
     *
     * The next due time comes with it, so one line answers both "is it alive" and
     * "why has it not fetched".
     */
    const [next] = await q.nextPlaylistRefreshAt();
    log(
      `[playlists] nothing due${next?.next_at ? `, next at ${new Date(next.next_at).toISOString()}` : ' (no lists stored)'}`,
    );
    return { checked: 0, changed: 0, failed: 0 };
  }

  let changed = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const r = await refreshPlaylist(row.user_id, { knownHash: row.content_hash });
      if (!r.unchanged) changed++;
    } catch {
      // markPlaylistError has already recorded it and set the back-off; a provider
      // being down must not stop the other lists being polled.
      failed++;
    }
  }

  log(`[playlists] ${due.length} due, ${changed} changed, ${failed} failed`);
  return { checked: due.length, changed, failed };
}

/**
 * Which of this reader's channels is carrying this fixture.
 *
 * Titles are matched with both team names required, so a channel that merely
 * mentions one club is rejected. Returns unsealed URLs, so the caller must already
 * have established that the requester owns them.
 */
/**
 * How long a "yes, this is streaming" verdict is worth trusting.
 *
 * Ten minutes, which is short. A provider slot that works at kick-off can be an
 * error page by half time -- that is the normal behaviour of these lines, not an
 * edge case -- so a stale yes is exactly the thing being fixed here. Long enough
 * that opening the page twice does not probe twice.
 */
const VERDICT_TTL_MS = 10 * 60 * 1000;

const freshEnough = (at) => Boolean(at) && Date.now() - new Date(at).getTime() < VERDICT_TTL_MS;

export async function ownChannelsFor({ userId, fixture }) {
  const none = { hasList: false, channelCount: 0, matches: [], competition: [] };
  if (!config.playlists.enabled || !userId) return none;

  const rows = await q.playlistChannels(userId);
  if (rows.length === 0) return none;

  const ranked = rankChannelsForFixture(
    rows.map((r) => ({ id: r.id, title: r.title, url: r.stream_url })),
    fixture,
  );
  const matches = [...ranked.certain, ...ranked.likely];

  // The count comes back even when nothing matched, and that is the point. Showing
  // nothing at all is indistinguishable from the feature being broken -- which is
  // exactly how it read when a list was added and no game ever lit up. "None of
  // your 7,059 channels look like they have this" is an answer; silence is not.
  // The id travels so a verdict from a probe can be written back to the row it
  // came from. rankChannelsForFixture only preserves the fields it is handed, so
  // it has to be carried in as well as out.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const unseal = (list) =>
    list
      .map((m) => {
        const row = byId.get(m.id);
        return {
          id: row?.id ?? null,
          title: m.title,
          // The provider's own shelf for this entry, so a row can say what it is
          // rather than being a bare name among several thousand. Never mapped
          // onto our own leagues -- see 0023.
          group: row?.group_title ?? null,
          kind: row?.kind ?? null,
          url: open(m.url),
          // What we last learned about this slot, so the page does not re-probe
          // something confirmed a moment ago. A verdict older than this is worth
          // nothing: these slots come and go during the day, which is the entire
          // reason the list needs checking rather than trusting.
          verified: row?.is_live === true && freshEnough(row.checked_at),
        };
      })
      .filter((m) => m.url)
      .slice(0, 10);

  return {
    hasList: true,
    channelCount: rows.length,
    matches: unseal(matches),
    // Channels for the SERIES rather than this fixture -- a 24/7 "F1 TV" carries
    // whatever Formula 1 is on. Shown separately so the page never claims more
    // than it knows.
    competition: unseal(ranked.competition),
  };
}

/**
 * The same question, asked from a fixture page.
 */
export async function ownChannelsForEvent({ userId, event }) {
  return ownChannelsFor({
    userId,
    fixture: {
      home: event.home_name,
      away: event.away_name,
      // Carried so a race, a fight card or a tournament -- which have no two sides
      // and so could never match on teams -- have something to match on.
      eventName: event.name,
      leagueName: event.league_name,
      leagueAbbr: event.league_abbr,
    },
  });
}

/**
 * And from a participant's own page, which never asked it.
 *
 * The sibling brand had the same gap and it was reported there first: a page a
 * reader reaches by searching for something to watch listed upcoming fixtures and
 * never once consulted their own list. Here the useful answer is usually the
 * competition tier -- a 24/7 club or league channel carries whatever that club is
 * doing -- so a team with no fixture today still has something to offer.
 *
 * One side, not two: `eventName` is the branch of the ranker built for a thing
 * with no opponent, which is exactly what a team page is.
 */
export async function ownChannelsForTeam({ userId, team }) {
  return ownChannelsFor({
    userId,
    fixture: {
      home: null,
      away: null,
      eventName: team.display_name ?? team.name,
      leagueName: team.league_name,
      leagueAbbr: team.league_abbr,
    },
  });
}

/**
 * Which of the SHARED lists is carrying this event.
 *
 * The same matching as ownChannelsForEvent, over other people's rows, and it
 * exists only because the owner of a line asked for one. Everything about this
 * table was built to make it impossible -- see migration 0024 for what the owner
 * is actually agreeing to -- so the differences from the private path are all
 * deliberate:
 *
 *   - The stream URL is NOT unsealed here. A shared entry is playable through the
 *     proxy and nowhere else, because every other route hands the reader the URL
 *     itself, and that URL carries the owner's provider username and password. A
 *     shared list that also handed out credentials would last exactly as long as
 *     it took one person to paste one.
 *   - Each row carries its owner, because the connection ceiling belongs to the
 *     owner's line rather than to whoever is watching.
 *   - Rows are keyed by channel id, so the routes can look one up without a
 *     viewer to scope by.
 *
 * @param {{viewerId: string|null, event: object}} args
 */
export async function sharedChannelsForEvent({ viewerId, event }) {
  const none = { channels: [], owners: 0 };
  if (!config.playlists.enabled || !viewerId) return none;

  const rows = await q.sharedPlaylistChannels({ viewerId });
  if (rows.length === 0) return none;

  const ranked = rankChannelsForFixture(
    rows.map((r) => ({ id: r.id, title: r.title, url: r.stream_url })),
    {
      home: event.home_name,
      away: event.away_name,
      // Carried so a race, a fight card or a tournament -- which have no two sides
      // and so could never match on teams -- have something to match on.
      eventName: event.name,
      leagueName: event.league_name,
      leagueAbbr: event.league_abbr,
    },
  );

  const byId = new Map(rows.map((r) => [r.id, r]));
  // The confident ones, then the likely ones, then the competition channels --
  // the same order the reader's own section uses, so the two read the same way.
  const flat = [...ranked.certain, ...ranked.likely, ...ranked.competition];

  const channels = flat
    .map((m) => {
      const row = byId.get(m.id);
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        group: row.group_title ?? null,
        ownerId: row.owner_id,
        ownerLabel: row.owner_label,
        // No `url`. Deliberately, and the absence is the security property: a
        // caller that wants to play this has to go through the proxy route, which
        // looks the row up again and never renders the URL into a page.
      };
    })
    .filter(Boolean)
    .slice(0, 10);

  return { channels, owners: new Set(channels.map((c) => c.ownerId)).size };
}

/**
 * The broadcaster listings, with the reader's own channels attached.
 *
 * ESPN and TheSportsDB say who carries a fixture in each country, and that was
 * rendered as text and nothing else -- so a reader whose own list contained the
 * exact channel being named still had to go and find it. This pairs the two.
 *
 * A listing with no match keeps its place and its text: it is still true that the
 * game is on that channel, we simply cannot offer it. Filtering those out would
 * turn a complete listing into a partial one and hide the fact that a market
 * exists at all.
 *
 * URLs are unsealed here, so the caller must already have established that the
 * requester owns them -- the same contract as ownChannelsForEvent.
 *
 * @param {{userId: string|null, markets: Array<{country: string, channels: string[]}>}} args
 */
export async function marketChannelsForEvent({ userId, markets }) {
  if (!config.playlists.enabled || !userId || !markets?.length) return null;

  const rows = await q.playlistChannels(userId);
  if (rows.length === 0) return null;

  const paired = marketsWithOwnChannels(
    markets,
    rows.map((r) => ({ id: r.id, title: r.title, url: r.stream_url })),
  );

  // Unsealed on the way out, and only for rows that actually matched -- there is
  // no reason to decrypt several thousand URLs to render a handful of buttons.
  const out = paired.map((m) => ({
    country: m.country,
    channels: m.channels.map((ch) => ({
      name: ch.name,
      own: ch.own.map((c) => ({ id: c.id, title: c.title, url: open(c.url) })).filter((c) => c.url),
    })),
  }));

  const matched = out.reduce(
    (n, m) => n + m.channels.reduce((k, ch) => k + (ch.own.length ? 1 : 0), 0),
    0,
  );
  // Nothing matched anywhere: the caller renders the plain listing it always did.
  return matched === 0 ? null : { markets: out, matched };
}
