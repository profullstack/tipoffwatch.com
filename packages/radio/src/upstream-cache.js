/**
 * One upstream fetch, however many tabs.
 *
 * A SiriusXM session is one subscription pinned to one IP, and what gets a
 * subscription flagged is the same bytes being pulled twice at once from it.
 * That is easy to do by accident: the same reader with the channel open in two
 * tabs, or a player that re-requests a manifest it already has. HLS makes the
 * fix cheap -- everybody asks for the same manifest and the same numbered
 * segments a moment apart -- so requests are collapsed two ways:
 *
 *   - in flight: concurrent requests for one URL share a single promise;
 *   - just after: the bytes are held briefly, so a request a second behind is
 *     served from memory rather than sent upstream again.
 *
 * The cache is small and short-lived on purpose. It exists to collapse
 * concurrent demand, not to store a broadcast: a live stream served stale is
 * worse than one served slow.
 */

/** A manifest changes every few seconds; a segment never changes once published. */
const MANIFEST_TTL_MS = 2_000;
const SEGMENT_TTL_MS = 30_000;
/** A few readers' worth of live audio, not a library. */
const MAX_BYTES = 32 * 1024 * 1024;

const cache = new Map();
const inFlight = new Map();
let heldBytes = 0;

const isManifest = (contentType, url) =>
  String(contentType ?? '')
    .toLowerCase()
    .includes('mpegurl') || url.includes('.m3u8');

function evict() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      heldBytes -= entry.bytes;
    }
  }
  if (heldBytes <= MAX_BYTES) return;
  for (const [key, entry] of cache) {
    cache.delete(key);
    heldBytes -= entry.bytes;
    if (heldBytes <= MAX_BYTES) break;
  }
}

/**
 * @param {string} key the upstream URL
 * @param {() => Promise<{body: ArrayBuffer, contentType: string|null, status: number}>} fetcher
 *   the real request; called at most once per key at a time
 * @returns {Promise<{body: ArrayBuffer, contentType: string|null, status: number, cached: boolean}>}
 */
export async function sharedFetch(key, fetcher) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return { ...hit, cached: true };

  const pending = inFlight.get(key);
  if (pending) return { ...(await pending), cached: true };

  const promise = (async () => {
    const res = await fetcher();
    const entry = {
      body: res.body,
      contentType: res.contentType,
      status: res.status,
      expiresAt: Date.now() + (isManifest(res.contentType, key) ? MANIFEST_TTL_MS : SEGMENT_TTL_MS),
      bytes: res.body.byteLength,
    };
    // An error must not be pinned for thirty seconds.
    if (res.status >= 200 && res.status < 300) {
      cache.set(key, entry);
      heldBytes += entry.bytes;
      evict();
    }
    return entry;
  })();

  inFlight.set(key, promise);
  try {
    return { ...(await promise), cached: false };
  } finally {
    inFlight.delete(key);
  }
}

export function cacheStats() {
  return { entries: cache.size, bytes: heldBytes, inFlight: inFlight.size };
}

export function resetCache() {
  cache.clear();
  inFlight.clear();
  heldBytes = 0;
}
