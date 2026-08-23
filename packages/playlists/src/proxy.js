/**
 * Putting a stream in front of a browser, which cannot fetch it itself.
 *
 * Everything else in this feature deliberately keeps tipoffwatch out of the path
 * of the video: the reader's own URL goes back to the reader's own player and no
 * bytes cross this server. That is still the better route wherever it works, and
 * it is still what the VLC, Infuse and .m3u buttons do.
 *
 * It cannot work in a browser, and not for one reason but four, each of which is
 * on its own fatal:
 *
 *   - The provider serves `http://`. A page on https may not load an http media
 *     source, and no header relaxes that -- mixed content is not a CSP decision,
 *     so there is nothing to loosen.
 *   - It sends no CORS headers, so even an https provider would be unreadable by
 *     a script on our origin.
 *   - The URL is the reader's subscription credential. In an href it is already
 *     exposed to whoever is holding the phone, which is acceptable because that
 *     is the account's own owner; handed to a page it would also sit in history,
 *     in the referrer of anything the page loads next, and in reach of any
 *     extension reading the DOM.
 *   - Some lines answer only a player-shaped user agent, and a browser cannot
 *     forge one.
 *
 * So for the browser -- and only for the browser -- the bytes come through here.
 * What arrives is MPEG-2 Transport Stream, which no browser can decode natively
 * either; the page transmuxes it to fMP4 and feeds Media Source Extensions. That
 * transmux is deliberately the CLIENT's job: this stays a byte pipe with no
 * ffmpeg, no segmenting and no per-viewer CPU, which is the difference between a
 * feature that runs on the container already deployed and one that needs a fleet.
 *
 * One reader, one upstream connection, and it belongs to the account that
 * supplied it. This is not a restream: nothing here is shared between accounts,
 * cached, or reachable without the session of the person whose subscription it
 * is.
 */

import { PLAYABLE_TYPE, probeStream } from './probe.js';

export { probeStream };

/** Long enough for a redirect to a token URL; short enough to fail a dead slot fast. */
const CONNECT_TIMEOUT_MS = 8000;

/**
 * Line up as a player, because a browser cannot.
 *
 * The same string the probe uses, and for the same reason: several of these
 * panels answer a browser-shaped agent with an error page and a real player with
 * video.
 */
const PLAYER_UA = 'VLC/3.0.20 LibVLC/3.0.20';

/**
 * Open the upstream and hand back its body, or say why not.
 *
 * One connection, not two. The .m3u route probes first and then lets a desktop
 * player open its own connection, which is fine because the probe has let go by
 * then. Here a probe would be a second simultaneous connection on a line that
 * caps them -- so the check and the playback are the same request: read the
 * headers, decide, and if it is video keep the body flowing.
 *
 * @param {string} url
 * @param {{ signal?: AbortSignal }} opts the request's signal, so a reader who
 *   closes the tab drops the provider connection with it. Without it the line
 *   holds a slot open for a viewer who left, which is how a subscription reaches
 *   its concurrent-stream cap with nobody watching.
 * @param {number} [opts.connectTimeoutMs] overridable so the timeout branch can be
 *   tested in milliseconds rather than by making a test wait eight seconds --
 *   which is how that branch ends up untested.
 */
export async function openStream(url, { signal, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, status: 502, note: 'not a fetchable url' };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  // Bounds reaching the provider, NOT watching it. Cleared the moment the headers
  // arrive: a timeout that survived into playback would cut the match off after
  // eight seconds.
  const timer = setTimeout(abort, connectTimeoutMs);

  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': PLAYER_UA },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // A reader who navigated away is not a failure, and must not be written back
    // to the channel row as one.
    if (signal?.aborted) return { ok: false, status: 499, note: 'closed', silent: true };
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return { ok: false, status: 504, note: aborted ? 'timed out' : 'could not connect' };
  }
  clearTimeout(timer);

  const type = (res.headers.get('content-type') ?? '').trim();

  const fail = (status, note) => {
    // Let the connection go rather than leaving it to a finaliser. These lines
    // count concurrent streams, and a leaked one counts.
    res.body?.cancel().catch(() => {});
    signal?.removeEventListener('abort', abort);
    return { ok: false, status, note };
  };

  if (!res.ok) return fail(502, `provider answered ${res.status}`);

  // The common failure: a dead slot answers 200 with an HTML page saying so.
  if (/^text\/html/i.test(type)) return fail(502, 'returned a web page, not a stream');

  /*
   * An HLS playlist is playable, but not by this page.
   *
   * The transmuxer on the other end reads transport stream; handed an .m3u8 it
   * fails with a decoder error, which reads as "the player is broken" rather than
   * "this one needs a different player". Nothing in the measured 7,059-entry list
   * is HLS, but a provider can change that overnight, and being told to open it
   * in VLC is a working answer where a black rectangle is not.
   */
  if (/mpegurl/i.test(type)) return fail(415, 'that channel is an HLS playlist');

  if (!PLAYABLE_TYPE.some((re) => re.test(type))) {
    return fail(502, type ? `unexpected type ${type}` : 'no content type');
  }

  return { ok: true, body: res.body, contentType: type, note: type };
}

/**
 * How many of these one account may have open at once.
 *
 * Not a rate limit, and not about our capacity. A provider line permits a small
 * number of simultaneous connections -- often exactly one -- and exceeding it is
 * what gets a subscription suspended. The reader owns that line, so this ceiling
 * protects THEM: better to be told "you are already watching something" than to
 * have the account cut off.
 *
 * In process, not in Redis, because there is one web container. Splitting the web
 * role across instances makes this per-instance and therefore too generous; that
 * is the moment to move the counter, and the reason it is a small module of its
 * own rather than a variable inside the route.
 */
const open = new Map();

export function claimStreamSlot(userId, { max = 1 } = {}) {
  const n = open.get(userId) ?? 0;
  if (n >= max) return null;
  open.set(userId, n + 1);
  let released = false;
  return () => {
    // Idempotent: this is called from a stream teardown, which can fire on both
    // cancel and error for the same viewer. Counting that twice would walk the
    // slot count downward until the cap stopped applying at all.
    if (released) return;
    released = true;
    const left = (open.get(userId) ?? 1) - 1;
    if (left <= 0) open.delete(userId);
    else open.set(userId, left);
  };
}

/** Only for tests: the counter is process-wide and outlives a test file. */
export function _resetStreamSlots() {
  open.clear();
}
