/*
 * What each directive is here to permit, so the next person to add a resource
 * knows which line to widen and why it was narrow.
 *
 *   script-src   our own bundles and the analytics beacon. No 'unsafe-inline' and
 *                no hashes: there is no inline script at all (the push key used
 *                to be one; the browser now fetches it from
 *                /api/push/vapid-public-key), so adding one fails loudly in
 *                development rather than quietly widening the policy.
 *   style-src    'unsafe-inline' is NOT here either -- the stylesheet is a file
 *                and no view emits a style attribute. Google Fonts is named
 *                because styles.css @imports it.
 *   img-src      https: wholesale, because team and league crests are hotlinked
 *                from whichever CDN the upstream provider hands us; enumerating
 *                them would mean a deploy every time a league changes host.
 *   media-src    blob:, which is what MediaSource hands the <video> element on
 *                the stream player. Without it Play fails with no console error
 *                that names the cause.
 *   worker-src   blob: as well, for the radio player's demuxing worker.
 *   frame-ancestors  the clickjacking control that actually matters; the site is
 *                never meant to be embedded.
 *   form-action  every control on the site is a plain form posting to us, so a
 *                form that posts anywhere else is an injection.
 */
/**
 * The policy. A function rather than a constant so a test builds exactly what the
 * header carries.
 */
export const buildPolicy = () =>
  [
    "default-src 'self'",
    "script-src 'self' https://crawlproof.com",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    /*
     * 'self' is NOT redundant with https: here.
     *
     * It reads as though it were -- the site is https, so https: already covers
     * its own icons. It does not cover them over http, which is every
     * developer's localhost: without 'self' every favicon and the header logo
     * were refused on a local run while the deployed site looked fine. Found by
     * loading a real page under this policy in a browser. No unit test would
     * have caught it, because the string is exactly what it was meant to say.
     */
    "img-src 'self' https: data:",
    "media-src 'self' blob:",
    "connect-src 'self' https://crawlproof.com",
    /*
     * blob: alongside 'self', for hls.js. The radio player demuxes in a worker
     * it builds from a blob URL; refused, it falls back to the main thread and
     * still plays, but audio decoding on the thread that draws the page is a
     * stutter on a phone. Only our own scripts can mint a blob, so this widens
     * nothing that script-src has not already decided.
     */
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

/**
 * Response headers every page and asset carries.
 *
 * Deliberately not conditional on the route: a header that applies to "the pages"
 * is a header somebody forgets on the one endpoint that needed it. HSTS is safe
 * to send unconditionally here because the site has been HTTPS-only since it had
 * a domain, and Railway terminates TLS in front of it.
 *
 * `preload` is left off on purpose -- the preload list's own operators now
 * discourage submitting to it, and getting off it takes months.
 */
export const SECURITY_HEADERS = {
  'content-security-policy': buildPolicy(),
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  // Redundant with frame-ancestors for anything modern, and the whole policy for
  // anything that is not.
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // Nothing here uses a camera, a microphone or a location. Saying so costs a
  // header and removes the whole class of question.
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};
