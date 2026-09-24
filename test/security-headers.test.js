import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { buildPolicy, SECURITY_HEADERS } = await import('../apps/web/src/lib/security-headers.js');
const { Layout } = await import('../apps/web/src/views/Layout.jsx');

const csp = buildPolicy();

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
   * There is no inline script to allow. The push key used to be one, hashed into
   * this header; the browser now fetches it from /api/push/vapid-public-key, so a
   * key that changes (or was missing when a page was cached) cannot desynchronise
   * the page from its policy.
   */
  test('the page carries no inline script and the policy no hash', async () => {
    const out = (await Layout({ user: null, children: 'x' }).toString()).toString();
    expect(out).not.toMatch(/<script>/);
    expect(out).not.toContain('__VAPID');
    expect(csp).not.toContain('sha256-');
  });

  test('and the header the site actually sends is the same policy', () => {
    expect(SECURITY_HEADERS['content-security-policy']).toBe(csp);
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
