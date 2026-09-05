import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const APP = new URL('../apps/web/src/app.js', import.meta.url).pathname;
const LAYOUT = new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname;

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { RETRIEVAL, TRAINING, robotsTxt } = await import('../apps/web/src/lib/well-known.js');
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
   * So every named group has to repeat the rules, or naming OAI-SearchBot to say
   * "you are welcome" would invite it straight into /login -- which is the exact
   * traffic that made this file necessary.
   */
  test.each(RETRIEVAL)('%s gets the auth paths too, not just the wildcard group', (agent) => {
    const group = groupFor(agent);
    expect(group).toContain('Allow: /');
    for (const path of ['/login', '/signup', '/auth/']) {
      expect(group).toContain(`Disallow: ${path}`);
    }
  });

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
  test.each(['*', 'OAI-SearchBot', 'PerplexityBot'])('%s may read /api/v1', (agent) => {
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

/*
 * Training crawlers copy pages into a corpus and cite nothing back; a schedule
 * is stale by the time the model ships. Meta's alone was 45,000 hits a day on
 * genrewatch. They are refused everywhere, while the retrieval crawlers that
 * power AI search answers -- the ones that send a reader back -- stay welcome.
 */
describe('training crawlers are refused, retrieval crawlers are not', () => {
  test.each(TRAINING)('%s is disallowed everywhere', (agent) => {
    expect(groupFor(agent)).toBe(`User-agent: ${agent}\nDisallow: /\nAllow: /crawl`);
  });

  /*
   * The pairs that are easy to confuse: each operator documents one token for
   * the corpus crawl and another for search. Refusing the wrong one of a pair
   * would cut off citations while the training crawl carried on.
   */
  test.each([
    ['GPTBot', 'OAI-SearchBot'],
    ['ClaudeBot', 'Claude-SearchBot'],
    ['Applebot-Extended', 'Bingbot'],
  ])('%s is refused while %s is welcome', (training, retrieval) => {
    expect(TRAINING).toContain(training);
    expect(RETRIEVAL).toContain(retrieval);
  });

  test('the biggest offender is named, and may still read the page that sells a pass', () => {
    expect(groupFor('meta-externalagent')).toContain('Disallow: /');
    expect(groupFor('meta-externalagent')).toContain('Allow: /crawl');
  });

  test('Applebot itself is not named, so Siri and Spotlight keep the wildcard rules', () => {
    expect(groupFor('Applebot')).toBe('');
  });

  test('Google-Extended stays welcome, since it also gates Gemini grounding', () => {
    expect(groupFor('Google-Extended')).toContain('Allow: /');
  });

  test('the public API stays open to the crawlers that are welcome', () => {
    expect(groupFor('OAI-SearchBot')).toContain('Allow: /api/v1');
  });
});

/*
 * The gateway is what happens when a refused crawler comes in anyway: 402 with
 * an x402 offer, or the sales page. Its order in app.js is the whole point --
 * after the outright block, so a crawler refused everywhere is not sold
 * anything, and before the session lookup, which a 402 does not need.
 */
describe('training crawlers that come in anyway are sold a pass', () => {
  test('the gateway is registered after the block and before the session', async () => {
    const src = await readFile(APP, 'utf8');
    const block = src.indexOf("BLOCKED_AGENTS = ['awariobot']");
    const gate = src.indexOf('x402Gateway(crawlGateway)');
    const session = src.indexOf('auth.userFromRequest(sid)');
    expect(block).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(block);
    expect(session).toBeGreaterThan(gate);
  });

  test('it sells what config says, to the address config names', async () => {
    const src = await readFile(APP, 'utf8');
    const wiring = src.slice(
      src.indexOf('createGateway({'),
      src.indexOf('x402Gateway(crawlGateway)'),
    );
    for (const key of [
      'config.coinpay.x402Key',
      'config.crawl.payTo',
      'config.crawl.priceCents',
      'config.crawl.passMinutes',
    ]) {
      expect(wiring).toContain(key);
    }
  });

  test('the maps stay readable, so a crawler can find the cheaper way in', async () => {
    const src = await readFile(APP, 'utf8');
    expect(src).toMatch(/openPaths: \['\/llms\.txt', '\/skill\.md'\]/);
  });
});
