/**
 * Asking the provider's panel about the line itself.
 *
 * Most of these playlists come from an Xtream-style panel (XUI.one and its
 * relatives), and every such panel has one endpoint that talks about the ACCOUNT
 * rather than the channels: `player_api.php?username=&password=` answers with
 * `user_info`, which carries `max_connections`, `active_cons`, `status` and
 * `exp_date`. That is the number this whole feature hangs on -- how many streams
 * this line may carry at once -- straight from the party that enforces it.
 *
 * It is a JSON request, not a stream, so it does not count against the line's
 * connections and can be made while something is playing. It is made once per
 * import and refresh, never per page view.
 *
 * Everything here answers null rather than throwing. A list that is not an Xtream
 * panel is a perfectly good list, and an import must not fail because the
 * question about connections could not be asked.
 */

/** The same string the import fetch sends. These panels answer it. */
const UA = 'curl/8.5.0 (+https://tipoffwatch.com)';

/** Long enough for a slow panel; short enough that a refresh is not held up. */
const TIMEOUT_MS = 8000;

/**
 * Where the panel's account endpoint is, given the playlist address.
 *
 * Both shapes an XUI panel hands out are covered -- the same two mask.js knows:
 *
 *   http://host/get.php?username=U&password=P&type=m3u_plus
 *   http://host/playlist/U/P/m3u_plus        (also /get.php/U/P/... and /live/U/P/...)
 *
 * Anything else is null. A bare `/U/P/123` is what a STREAM url looks like, and a
 * reader who pasted one of those has not pasted a playlist; guessing credentials
 * out of an unknown path shape is how a wrong pair gets sent to somebody's server.
 *
 * @param {string} playlistUrl
 * @returns {string|null}
 */
export function panelApiUrl(playlistUrl) {
  let parsed;
  try {
    parsed = new URL(playlistUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;

  let username = parsed.searchParams.get('username');
  let password = parsed.searchParams.get('password');

  if (!username || !password) {
    const segments = parsed.pathname.split('/').filter(Boolean);
    const route = segments[0]?.toLowerCase();
    if (
      ['playlist', 'get.php', 'live', 'm3u', 'xmltv.php'].includes(route) &&
      segments.length >= 3
    ) {
      username = decodeURIComponent(segments[1]);
      password = decodeURIComponent(segments[2]);
    }
  }
  if (!username || !password) return null;

  const api = new URL('/player_api.php', parsed.origin);
  api.searchParams.set('username', username);
  api.searchParams.set('password', password);
  return api.toString();
}

/**
 * What the panel says about this line, or null.
 *
 * @param {string} playlistUrl
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts] injectable so the
 *   parsing can be tested without a panel, and the timeout without waiting.
 * @returns {Promise<{
 *   maxConnections: number|null,
 *   activeConnections: number|null,
 *   status: string|null,
 *   expiresAt: Date|null,
 * } | null>}
 */
export async function lineInfo(
  playlistUrl,
  { fetch: doFetch = fetch, timeoutMs = TIMEOUT_MS } = {},
) {
  const api = panelApiUrl(playlistUrl);
  if (!api) return null;

  let body;
  try {
    const res = await doFetch(api, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }

  const info = body?.user_info;
  if (!info || typeof info !== 'object') return null;

  return {
    maxConnections: count(info.max_connections),
    activeConnections: count(info.active_cons),
    status: typeof info.status === 'string' && info.status ? info.status.slice(0, 40) : null,
    expiresAt: expiry(info.exp_date),
  };
}

/** These panels send numbers as strings ("1"), and some send nothing. */
function count(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Unix seconds as a string, or null for a line that does not expire. */
function expiry(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const at = new Date(n * 1000);
  return Number.isNaN(at.getTime()) ? null : at;
}
