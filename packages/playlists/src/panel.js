/**
 * Asking the provider's panel about the line itself.
 *
 * Most of these playlists come from an Xtream-style panel (XUI.one and its
 * relatives), and every such panel has one endpoint that talks about the ACCOUNT
 * rather than the channels: `player_api.php?username=&password=` answers with
 * `user_info`, which carries `max_connections`, `active_cons`, `status` and
 * `exp_date`. That is the number line connections hang on: how many streams
 * this line may carry at once, straight from the party that enforces it.
 *
 * The parsing and the request are @profullstack/stream-providers' Xtream
 * adapter, shared with every site that reads these panels. What is ours is the
 * user agent the import fetch also sends. Everything answers null rather than
 * throwing: a list that is not an Xtream panel is a perfectly good list.
 */

import { lineInfo as panelLineInfo } from '@profullstack/stream-providers/xtream';

export { panelApiUrl } from '@profullstack/stream-providers/xtream';

/** The same string the import fetch sends. These panels answer it. */
const UA = 'curl/8.5.0 (+https://tipoffwatch.com)';

/**
 * What the panel says about this line, or null.
 *
 * @param {string} playlistUrl
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts]
 */
export function lineInfo(playlistUrl, { fetch, timeoutMs } = {}) {
  return panelLineInfo(playlistUrl, {
    userAgent: UA,
    ...(fetch ? { fetch } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}
