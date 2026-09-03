/**
 * @tipoff/radio -- a reader's own SiriusXM, played here.
 *
 * The BYO rail for radio: the reader connects their own subscription in
 * settings with the code SiriusXM emails them, and the sports and news lineups
 * play in the page through a proxy that holds their session and never shows it
 * to the browser. Nothing is pooled or resold; every byte is fetched as the one
 * reader who owns the account.
 */

export { dropPending, peekPending, putPending, takePending } from './pending.js';
export {
  bearerFor,
  channel,
  channels,
  disconnect,
  forget,
  proxyFor,
  saveSession,
  search,
  storedSession,
  tune,
} from './session.js';
export {
  API_HEADERS,
  CATEGORIES,
  completeOtpLogin,
  DEFAULT_QUALITY,
  decodeKeyJson,
  isKeyUrl,
  isSiriusXmUrl,
  looksLikePlaylist,
  parseStationId,
  QUALITIES,
  rewritePlaylist,
  SiriusXmError,
  startOtpLogin,
  stationId,
  sxmFetch,
} from './siriusxm.js';
export { sharedFetch } from './upstream-cache.js';
