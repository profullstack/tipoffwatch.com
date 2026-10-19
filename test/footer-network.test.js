import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { Layout } = await import('../apps/web/src/views/Layout.jsx');
const { dataSource } = await import('../packages/config/src/brands.js');

/*
 * The footer only. Asserting over the whole document would let a canonical tag
 * or an og:url satisfy a test about what the footer links to.
 */
const footer = async (props) => {
  const out = (await Layout(props).toString()).toString();
  return out.slice(out.indexOf('<footer>'), out.indexOf('</footer>') + 9);
};

/*
 * The site footer is the data credit; the links, copyright and webring are the
 * @profullstack/footer row after it.
 */
describe('the site footer', () => {
  test('credits the data platform', async () => {
    const out = await footer({ user: null, children: 'x' });
    expect(out).toContain('Data furnished by');
    expect(out).toContain(`href="${dataSource.url}"`);
    expect(out).toContain('nichedb.dev');
  });

  test('does not repeat the network list or the webring', async () => {
    const out = await footer({ user: null, children: 'x' });
    expect(out).not.toContain('https://genrewatch.com');
    expect(out).not.toContain('https://watchnews.now');
  });

  test('is one row: the data credit', async () => {
    const out = await footer({ user: null, children: 'x' });
    expect(out.match(/<p /g)?.length).toBe(1);
  });

  test('is followed by the webring row, and carries no pit.world footer', async () => {
    // tipoffwatch.com is not a Moshpit name; the pit.world footer is not for it.
    const out = (await Layout({ user: null, children: 'x' }).toString()).toString();
    expect(out).toContain('ring/profullstack');
    expect(out).not.toContain('data-pit-footer');
  });
});
