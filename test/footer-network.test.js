import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { Layout } = await import('../apps/web/src/views/Layout.jsx');
const { brands, dataSource, network } = await import('../packages/config/src/brands.js');

/*
 * The footer only. Asserting over the whole document would let a canonical tag
 * or an og:url satisfy a test about what the footer links to.
 */
const footer = async (props) => {
  const out = (await Layout(props).toString()).toString();
  return out.slice(out.indexOf('<footer>'), out.indexOf('</footer>') + 9);
};

/*
 * The footer is the only thing on every page of every site, which makes it the
 * one place the network can be stated once and be true everywhere. These tests
 * guard the two ways that quietly stops being true: a new brand that nobody
 * remembers to add, and a site that links to itself instead of its siblings.
 */
describe('the network line', () => {
  test('is derived from the brands, so a new site cannot be forgotten', () => {
    expect(network.map((s) => s.domain).sort()).toEqual(
      Object.values(brands)
        .map((b) => b.domain)
        .sort(),
    );
    expect(network.every((s) => s.url === `https://${s.domain}`)).toBe(true);
  });

  test('names every site we run, on a page of any of them', async () => {
    const out = await footer({ user: null, children: 'x' });
    for (const site of network) expect(out).toContain(site.name);
    expect(out).toContain('https://genrewatch.com');
    expect(out).toContain('https://watchnews.now');
  });

  /*
   * A link to where the reader already is, is noise -- but dropping the name
   * would make each site's footer a different list, which is how a reader stops
   * being able to tell these are one shop.
   */
  test('does not link the site the reader is already on', async () => {
    const out = await footer({ user: null, children: 'x' });
    expect(out).toContain('TipoffWatch');
    expect(out).not.toContain('href="https://tipoffwatch.com"');
  });

  test('credits the data platform', async () => {
    const out = await footer({ user: null, children: 'x' });
    expect(out).toContain('Data furnished by');
    expect(out).toContain(`href="${dataSource.url}"`);
    expect(out).toContain('nichedb.dev');
  });
});
