import { createHash } from 'node:crypto';
import { config } from '@tipoff/config';

/**
 * The one inline script on the whole site, as a string.
 *
 * It lives here rather than inside the Layout because the Content-Security-Policy
 * below has to hash exactly these bytes, and a policy that hashes a copy of the
 * markup is a policy that silently stops matching the first time somebody edits a
 * space into the template. One function, called by both, so they cannot drift --
 * and a test asserts the rendered page really does contain what was hashed.
 *
 * The alternative was a nonce, which cannot work here: signed-out pages are
 * rendered once and served from Redis to everyone, so a nonce baked into the
 * cached HTML would disagree with the header on every subsequent request.
 */
export const vapidScript = (key) => `window.__VAPID = "${key}";`;

/** CSP source expression for an inline script's contents. */
const sha256 = (src) => `'sha256-${createHash('sha256').update(src, 'utf8').digest('base64')}'`;

/*
 * What each directive is here to permit, so the next person to add a resource
 * knows which line to widen and why it was narrow.
 *
 *   script-src   our own bundles, the analytics beacon, and the VAPID line above.
 *                No 'unsafe-inline': there is exactly one inline script and it is
 *                hashed, so adding a second one fails loudly in development
 *                rather than quietly widening the policy for everybody.
 *   style-src    'unsafe-inline' is NOT here either -- the stylesheet is a file
 *                and no view emits a style attribute. Google Fonts is named
 *                because styles.css @imports it.
 *   img-src      https: wholesale, because team and league crests are hotlinked
 *                from whichever CDN the upstream provider hands us; enumerating
 *                them would mean a deploy every time a league changes host.
 *   media-src    blob:, which is what MediaSource hands the <video> element on
 *                the stream player. Without it Play fails with no console error
 *                that names the cause.
 *   frame-ancestors  the clickjacking control that actually matters; the site is
 *                never meant to be embedded.
 *   form-action  every control on the site is a plain form posting to us, so a
 *                form that posts anywhere else is an injection.
 */
/**
 * The policy, as a function of the one key that varies.
 *
 * A parameter rather than a read of `config` inside, so a test can build the
 * policy for a known key instead of depending on whether it happened to set the
 * environment before something else imported config -- which in a shared module
 * registry is decided by test file ordering.
 *
 * Every page that carries the inline script carries `config.push.publicKey`, so
 * one hash covers all of them. With push unconfigured there is no inline script
 * and no hash, and the policy is stricter rather than broken.
 */
export const buildPolicy = (publicKey) =>
  [
    "default-src 'self'",
    `script-src 'self' https://crawlproof.com${publicKey ? ` ${sha256(vapidScript(publicKey))}` : ''}`,
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
    "worker-src 'self'",
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
  'content-security-policy': buildPolicy(config.push.publicKey),
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
