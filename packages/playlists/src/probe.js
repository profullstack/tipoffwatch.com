/**
 * Does this channel actually play?
 *
 * A provider playlist is mostly aspirational. The slot exists and the title is
 * right, and a large share of them answer with an HTML error page rather than
 * video -- measured against a real line: several endpoints returned
 * `text/html; charset=UTF-8` with zero bytes where a stream was advertised.
 * Handing one of those to somebody during a match is worse than handing them
 * nothing, because they find out by tapping it.
 *
 * The check is deliberately small: ask for the first couple of kilobytes and look
 * at what comes back. That is enough to tell video from an error page, costs no
 * meaningful bandwidth, and holds the upstream connection for under a second --
 * which matters, because these lines cap concurrent connections and a probe that
 * lingers is a probe that competes with the reader's own playback.
 *
 * Two things it learned the hard way, and both are about what a NO means.
 *
 * A verdict is now three-valued, not two. "I asked and it served a web page" and
 * "I could not reach it in six seconds" are both `live: false` at the moment of
 * asking, and they are nothing alike afterwards: the first is a fact about the
 * slot, the second is a fact about the last six seconds. They were persisted
 * identically, and a persisted no hides the row from the candidate query for
 * thirty minutes -- so one timeout on the right channel meant the reader was
 * offered the next-best thing instead (the wrong game), or nothing at all. Only a
 * `definitive` verdict is worth remembering; see the callers, which write NULL
 * rather than false for the rest.
 *
 * And the bytes are the evidence, not the content-type header. These panels serve
 * MPEG-TS as `text/plain`, as `application/dash+xml`, and with no content-type at
 * all, and a working channel was being called dead on the strength of a header
 * its own video did not agree with. A transport stream announces itself: 0x47,
 * once every 188 bytes, by specification.
 */

/**
 * What a working stream looks like coming back.
 *
 * Exported because the browser proxy has to make the same judgement from the same
 * headers, and two lists that drift apart would mean a channel the probe calls
 * live and the player calls broken. Kept as a hint rather than the decision --
 * the first bytes outrank it in both directions.
 */
export const PLAYABLE_TYPE = [
  /^video\//i,
  /^audio\//i,
  // MPEG-TS, which is what most of these actually serve.
  /^application\/(octet-stream|x-mpegurl|vnd\.apple\.mpegurl)/i,
];

/** Long enough for a redirect and first bytes; short enough not to hold a slot. */
const TIMEOUT_MS = 6000;

/** How much of the body is worth looking at to tell video from an apology. */
const SNIFF_BYTES = 2048;

/**
 * Statuses that say something permanent about the slot.
 *
 * Everything else -- 401, 403, 429, and the whole 5xx range -- is transient often
 * enough that remembering it is wrong. An Xtream panel answers 403 when the line
 * already has its one permitted connection open, which is to say: it answers 403
 * precisely when the reader is watching the channel that supposedly does not
 * work.
 */
const DEAD_STATUS = new Set([404, 410, 451]);

/**
 * Read the front of the body, then let go.
 *
 * Cancelled rather than drained. The point of the range request is to hold the
 * upstream for well under a second, and reading a live transport stream to
 * completion never finishes at all.
 *
 * @param {Response} res
 */
async function firstBytes(res) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const out = new Uint8Array(SNIFF_BYTES);
  let n = 0;
  try {
    while (n < SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const take = Math.min(value.length, SNIFF_BYTES - n);
      out.set(value.subarray(0, take), n);
      n += take;
    }
  } catch {
    // A stream that dies mid-read tells us nothing we did not already have.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, n);
}

/**
 * What do these bytes look like?
 *
 * Returns 'stream' for anything playable, 'page' for an apology, and null when
 * there is nothing to go on -- and null is not a no. A live channel that has not
 * produced a keyframe yet legitimately hands over an empty body.
 *
 * @param {Uint8Array} bytes
 */
export function sniffBytes(bytes) {
  if (!bytes?.length) return null;

  // MPEG-TS. The sync byte is the format's whole framing rule, and every one of
  // these panels serves TS whatever it claims in the header.
  if (bytes[0] === 0x47) return 'stream';

  // fragmented MP4 -- 'ftyp' or 'styp' as the box type, four bytes in.
  const box = String.fromCharCode(...bytes.subarray(4, 8));
  if (box === 'ftyp' || box === 'styp' || box === 'moov' || box === 'moof') return 'stream';

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 512))
    .replace(/^﻿/, '')
    .trim();
  if (!head) return null;

  if (/^#EXTM3U/i.test(head)) return 'stream';
  // An HTML apology, or an XML/JSON error payload from the panel. All three are
  // the same answer: this is not video.
  if (/^</.test(head)) return 'page';
  if (/^[{[]/.test(head)) return 'page';

  return null;
}

/**
 * One request, and what it proves.
 *
 * @param {string} url @param {AbortSignal} signal @param {boolean} ranged
 */
async function ask(url, signal, ranged) {
  const headers = { 'user-agent': 'VLC/3.0.20 LibVLC/3.0.20' };
  // Ranged, so a live stream hands over a couple of KB and lets go rather than
  // opening a session we then have to abandon mid-flight.
  if (ranged) headers.range = `bytes=0-${SNIFF_BYTES - 1}`;

  const res = await fetch(url, { headers, redirect: 'follow', signal });
  const type = (res.headers.get('content-type') ?? '').trim();
  return { res, type };
}

/**
 * @param {string} url
 * @param {{ signal?: AbortSignal }} [opts] the caller's signal -- normally the
 *   request's. A probe that outlives the reader who asked for it is a connection
 *   held open on a line that counts them, and the page verifies several channels
 *   in a row, so the reader who navigates away mid-sweep would otherwise leave
 *   one behind every time.
 * @returns {Promise<{ live: boolean, definitive: boolean, note: string }>}
 *   `definitive` is whether this verdict is worth remembering. A caller that
 *   persists an indefinite one hides a working channel for half an hour.
 */
export async function probeStream(url, { signal } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { live: false, definitive: true, note: 'not a fetchable url' };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);

  try {
    let { res, type } = await ask(url, controller.signal, true);

    // Some servers refuse a range on a live stream rather than ignoring it, which
    // is not a statement about the channel. Ask again for the whole thing; the
    // read is capped either way, so it costs the same couple of kilobytes.
    if (res.status === 416) {
      await res.body?.cancel().catch(() => {});
      ({ res, type } = await ask(url, controller.signal, false));
    }

    if (!res.ok && res.status !== 206) {
      await res.body?.cancel().catch(() => {});
      const dead = DEAD_STATUS.has(res.status);
      return {
        live: false,
        definitive: dead,
        note: `provider answered ${res.status}`,
      };
    }

    const bytes = await firstBytes(res);
    const looks = sniffBytes(bytes);

    // The bytes win, in both directions. A transport stream served as text/html
    // is a working channel behind a careless header, and an HTML apology served
    // as video/mp2t is still an apology.
    if (looks === 'stream') return { live: true, definitive: true, note: type || 'video' };
    if (looks === 'page') {
      return { live: false, definitive: true, note: 'returned a web page, not a stream' };
    }

    // Nothing conclusive in the body. The header is all that is left, and a
    // playable one is worth believing.
    if (PLAYABLE_TYPE.some((re) => re.test(type))) {
      return { live: true, definitive: true, note: type };
    }
    if (/^text\/html/i.test(type)) {
      return { live: false, definitive: true, note: 'returned a web page, not a stream' };
    }

    // Silence. Not a no: a channel between keyframes answers exactly like this,
    // and remembering it as dead is what took the right game off the page.
    return {
      live: false,
      definitive: false,
      note: bytes.length ? `unrecognised data${type ? ` (${type})` : ''}` : 'answered with no data',
    };
  } catch (err) {
    // Including the reader navigating away, which aborts the request signal. That
    // is a fact about the reader, not about the channel, and it must never be
    // written down as one.
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return {
      live: false,
      definitive: false,
      note: aborted ? 'timed out' : 'could not connect',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * What to write down about a probe, if anything.
 *
 * The one place that decides it, so no caller has to remember the rule: a yes and
 * a definite no are facts about the slot; everything else is a fact about the
 * last six seconds and is stored as "unknown" -- which the candidate query treats
 * as offerable, because it is.
 *
 * @param {{ live: boolean, definitive: boolean }} result
 * @returns {boolean|null}
 */
export function verdictToStore(result) {
  if (result?.live) return true;
  return result?.definitive ? false : null;
}

/**
 * Walk candidates in order and return the first that plays.
 *
 * Sequential on purpose. These are one subscriber's own connections and the line
 * caps how many can be open at once; probing five at a time to save two seconds
 * is how somebody's account gets flagged.
 *
 * @param {Array<{ title: string, url: string }>} candidates
 * @param {number} max how many to try before giving up
 */
export async function firstLiveChannel(candidates, { max = 4, onResult, signal } = {}) {
  const tried = [];
  for (const c of (candidates ?? []).slice(0, max)) {
    if (signal?.aborted) break;
    const result = await probeStream(c.url, { signal });
    tried.push({ ...c, ...result });
    if (onResult) await onResult(c, result);
    if (result.live) return { pick: c, tried };
  }
  return { pick: null, tried };
}
