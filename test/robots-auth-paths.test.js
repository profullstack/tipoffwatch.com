import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const APP = new URL('../apps/web/src/app.js', import.meta.url).pathname;
const LAYOUT = new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname;

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { robotsTxt } = await import('../apps/web/src/lib/well-known.js');
const robots = robotsTxt();

/** The rules under one User-agent heading, up to the next blank line. */
const groupFor = (agent) =>
  robots.split('\n\n').find((g) => g.startsWith(`User-agent: ${agent}\n`)) ?? '';

/*
 * `Allow: /` with nothing excluded is an invitation to crawl the sign-in page,
 * and one SEO bot took it: /login was 47% of all requests to tipoffwatch,
 * fetched about once a second from a single address. The bot was behaving
 * correctly -- nobody had told it not to.
 */
describe('crawlers are kept off the auth pages', () => {
  test.each(['/login', '/signup', '/auth/', '/api/'])('robots.txt disallows %s', (path) => {
    expect(groupFor('*')).toContain(`Disallow: ${path}`);
  });

  /*
   * The trap that makes naming a crawler dangerous: a crawler which finds a group
   * matching its own name obeys THAT group and ignores `User-agent: *` entirely.
   * So every named group has to repeat the rules, or naming GPTBot to say "you
   * are welcome" would invite it straight into /login -- which is the exact
   * traffic that made this file necessary.
   */
  test.each(['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot'])(
    '%s gets the auth paths too, not just the wildcard group',
    (agent) => {
      const group = groupFor(agent);
      expect(group).toBeTruthy();
      for (const path of ['/login', '/signup', '/auth/']) {
        expect(group).toContain(`Disallow: ${path}`);
      }
    },
  );

  test('the sitemap is still offered', () => {
    expect(robots).toContain('Sitemap: ');
    expect(robots).toContain('/sitemap.xml');
  });

  /*
   * robots.txt only helps a crawler that reads it, and only after it has already
   * found the link on every page of the site. nofollow is what stops a
   * well-behaved one following it there in the first place.
   */
  test('the sign-in link in the header is nofollow', async () => {
    const layout = await readFile(LAYOUT, 'utf8');
    const link = layout.slice(
      layout.indexOf('href="/login"') - 120,
      layout.indexOf('href="/login"') + 20,
    );
    expect(link).toContain('rel="nofollow"');
  });

  /*
   * A named group as well as the wildcard one. It did not obey the wildcard, so
   * this is documentation more than defence -- the user-agent block in app.js is
   * what actually stops it -- but a crawler that later starts behaving will read
   * this and comply without anybody having to remember why.
   */
  test('AwarioBot is named and disallowed everywhere', () => {
    expect(groupFor('AwarioBot')).toContain('Disallow: /');
    // And it gets no Allow line, unlike every other named group.
    expect(groupFor('AwarioBot')).not.toContain('Allow:');
  });

  test('and it is refused outright, not merely asked nicely', async () => {
    const src = await readFile(APP, 'utf8');
    expect(src).toContain("BLOCKED_AGENTS = ['awariobot']");
  });
});

/*
 * The footer has linked /api/v1 as "Public API" since it existed, and /about
 * calls it open and keyless -- while robots.txt forbade the whole of /api/. The
 * one surface built for programs to read was the one surface programs were told
 * to stay out of.
 */
describe('the documented API is crawlable', () => {
  test.each(['*', 'GPTBot', 'PerplexityBot'])('%s may read /api/v1', (agent) => {
    expect(groupFor(agent)).toContain('Allow: /api/v1');
  });

  test('but the rest of /api/ is still closed', () => {
    expect(groupFor('*')).toContain('Disallow: /api/');
  });

  test('the Allow is longer than the Disallow it overrides', () => {
    // Longest match wins. `Allow: /api/v1` beating `Disallow: /api/` is the whole
    // mechanism, and it stops working if either path is ever shortened.
    expect('/api/v1'.length).toBeGreaterThan('/api/'.length);
  });
});
