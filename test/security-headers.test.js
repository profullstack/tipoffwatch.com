import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { buildPolicy, SECURITY_HEADERS, vapidScript } = await import(
  '../apps/web/src/lib/security-headers.js'
);
const { Layout } = await import('../apps/web/src/views/Layout.jsx');

/** A real VAPID public key shape: 65 bytes, base64url. */
const KEY =
  'BDU8swQUlpZBiNRdnbaSMwmSuLhWzJXTX8QAJ0lSpNzPnnFsmwZbXpSTFqLrJDLPzYgIeUuMTQCzYtDcqLRqUCQ';

/*
 * Built for a known key rather than read off the shipped header. `bun test`
 * shares one module registry across files, so whichever file imports config first
 * decides what VAPID_PUBLIC_KEY was -- and a test that reads the live policy
 * passes alone and fails in a full run for reasons that have nothing to do with
 * the policy.
 */
const csp = buildPolicy(KEY);

describe('security headers', () => {
  test.each([
    'strict-transport-security',
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'permissions-policy',
    'content-security-policy',
  ])('%s is sent', (name) => {
    expect(SECURITY_HEADERS[name]).toBeTruthy();
  });

  test('HSTS covers subdomains but does not ask for the preload list', () => {
    // Getting onto preload is easy and getting off it takes months; its own
    // operators now discourage submitting.
    expect(SECURITY_HEADERS['strict-transport-security']).toContain('includeSubDomains');
    expect(SECURITY_HEADERS['strict-transport-security']).not.toContain('preload');
  });

  test('the page cannot be framed', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY');
  });
});

describe('the CSP matches the page it is protecting', () => {
  /*
   * The whole point of hashing rather than nonce-ing is that signed-out pages are
   * cached byte-identical in Redis, so a per-request nonce would disagree with the
   * header on every hit but the first. The cost of a hash is that it stops
   * matching the moment somebody edits the markup -- and a CSP that silently stops
   * matching takes push notifications down with it. So: hash what actually renders.
   */
  test('the hash in script-src is the hash of the inline script on the page', async () => {
    const out = (await Layout({ user: null, vapidKey: KEY, children: 'x' }).toString()).toString();

    const inline = out.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(inline).toBe(vapidScript(KEY));

    const hash = `'sha256-${createHash('sha256').update(inline, 'utf8').digest('base64')}'`;
    expect(csp).toContain(hash);
  });

  test('and the header the site actually sends is built the same way', () => {
    expect(SECURITY_HEADERS['content-security-policy']).toStartWith("default-src 'self';");
  });

  test('with push unconfigured there is no hash rather than a broken one', () => {
    const bare = buildPolicy(null);
    expect(bare).not.toContain('sha256-');
    expect(bare).not.toContain('unsafe-inline');
  });

  test('and nothing else may go inline', () => {
    // No 'unsafe-inline' escape hatch: a second inline script has to be a file, or
    // it fails visibly in development instead of widening the policy for everyone.
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  test('the analytics beacon is allowed to load and to report', () => {
    expect(csp).toContain('script-src');
    expect(csp).toContain('https://crawlproof.com');
    expect(csp.match(/connect-src[^;]*/)[0]).toContain('https://crawlproof.com');
  });

  test.each(['img-src', 'font-src', 'style-src', 'media-src', 'connect-src'])(
    "%s allows the site's own files",
    (directive) => {
      /*
       * `img-src https: data:` looks complete and is not: the site is https, so
       * https: covers its own icons in production while refusing every one of
       * them over http -- which is every developer's localhost. Found by loading
       * a real page under this policy in a browser, not by a test, which is why
       * there is now a test.
       */
      expect(csp.match(new RegExp(`${directive}[^;]*`))[0]).toContain("'self'");
    },
  );

  test('hotlinked crests still load', () => {
    // Crests come from whichever CDN the upstream provider currently uses, so the
    // policy names the scheme rather than the hosts.
    expect(csp.match(/img-src[^;]*/)[0]).toContain('https:');
  });

  test('the stream player can still attach a MediaSource', () => {
    // MSE hands <video> a blob: URL. Without this, Play fails with no error that
    // names the reason.
    expect(csp.match(/media-src[^;]*/)[0]).toContain('blob:');
  });

  test('the webfonts the stylesheet imports are allowed', () => {
    expect(csp.match(/style-src[^;]*/)[0]).toContain('https://fonts.googleapis.com');
    expect(csp.match(/font-src[^;]*/)[0]).toContain('https://fonts.gstatic.com');
  });
});
