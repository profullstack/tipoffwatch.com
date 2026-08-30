import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { Contact, Privacy, Terms } = await import('../apps/web/src/views/legal.jsx');
const { Layout } = await import('../apps/web/src/views/Layout.jsx');
const APP = new URL('../apps/web/src/app.js', import.meta.url).pathname;

const render = async (node) => (await node.toString()).toString();

describe('the pages exist and are reachable', () => {
  test.each(['/privacy', '/terms', '/contact'])('%s is routed', async (path) => {
    expect(await readFile(APP, 'utf8')).toContain(`app.get('${path}'`);
  });

  test.each(['/privacy', '/terms', '/contact'])('%s is linked from the footer', async (path) => {
    // A privacy policy nobody can find is a privacy policy nobody has, and the
    // footer is the only element on every page.
    const html = await render(Layout({ user: null, children: 'x' }));
    expect(html).toContain(`href="${path}"`);
  });

  test.each(['/privacy', '/terms', '/contact'])('%s is in the static sitemap', async (path) => {
    const src = await readFile(APP, 'utf8');
    const block = src.slice(src.indexOf("app.get('/sitemaps/static.xml'"));
    expect(block.slice(0, 700)).toContain(`'${path}'`);
  });

  test('the sitemap no longer lists what robots.txt forbids', async () => {
    // Listing /login in the sitemap asked a crawler to fetch what the same site
    // had just told it not to -- and /login being crawled is why robots.txt
    // exists here at all.
    const src = await readFile(APP, 'utf8');
    const block = src.slice(
      src.indexOf("app.get('/sitemaps/static.xml'"),
      src.indexOf("app.get('/sitemaps/feeds.xml'"),
    );
    expect(block).not.toContain("'/login'");
    expect(block).not.toContain("'/signup'");
  });
});

describe('the privacy policy describes this site, not a template', () => {
  test('names the three cookies that are actually set', async () => {
    // Checked against app.js: a policy listing a cookie the site does not set,
    // or missing one it does, is worse than none because it reads as authority.
    const html = await render(Privacy({ user: null }));
    const src = await readFile(APP, 'utf8');
    for (const cookie of ['tw_session', 'tw_pk', 'tw_invite']) {
      expect(html).toContain(cookie);
    }
    expect(src).toContain("'tw_pk'");
  });

  test('discloses the analytics script the Layout loads', async () => {
    const html = await render(Privacy({ user: null }));
    expect(html).toContain('crawlproof.com');
    // It sets no cookie and uses localStorage; saying so is the difference
    // between a disclosure and a boilerplate paragraph.
    expect(html).toContain('local storage');
  });

  test('is explicit that imported playlist credentials are encrypted', async () => {
    // The stored URL carries the reader's provider username and password.
    const html = await render(Privacy({ user: null }));
    expect(html).toContain('AES-256-GCM');
  });

  test('says where an IP address is stored, since one is', async () => {
    expect(await render(Privacy({ user: null }))).toContain('IP address');
  });

  test('offers deletion', async () => {
    expect((await render(Privacy({ user: null }))).toLowerCase()).toContain('delet');
  });
});

describe('contact', () => {
  test('points at the machine-readable version too', async () => {
    expect(await render(Contact({ user: null }))).toContain('/.well-known/security.txt');
  });

  test('publishes no address when none is configured', async () => {
    // config.contactEmail has no default on purpose: a hello@ nobody reads looks
    // like a working contact to everyone who writes to it.
    expect(await render(Contact({ user: null }))).not.toContain('mailto:hello@');
  });
});

describe('terms', () => {
  test('states the paid tier does not auto-renew', async () => {
    const html = await render(Terms({ user: null }));
    expect(html).toContain('nothing renews');
  });

  test('is honest that reminders are not guaranteed', async () => {
    // The schedules come from upstream providers and can be wrong or late. A
    // terms page that implied otherwise would be a promise the code cannot keep.
    expect(await render(Terms({ user: null }))).toContain('no promise of uptime');
  });
});
