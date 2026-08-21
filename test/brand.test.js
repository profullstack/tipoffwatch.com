import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const load = async (id) => {
  const saved = process.env.BRAND;
  if (id === undefined) delete process.env.BRAND;
  else process.env.BRAND = id;
  try {
    return await import(`../packages/config/src/brands.js?b=${id}&t=${Date.now()}`);
  } finally {
    if (saved === undefined) delete process.env.BRAND;
    else process.env.BRAND = saved;
  }
};

describe('the whitelabel override point', () => {
  test('defaults to the flagship site', async () => {
    const { brand } = await load(undefined);
    expect(brand.id).toBe('tipoffwatch');
  });

  /*
   * A typo in an env var should serve the flagship site, not take the deployment
   * down. There is no correctness riding on the brand -- it is words and paths --
   * so failing closed here would be worse than failing over.
   */
  test('an unknown brand falls back rather than throwing', async () => {
    const { brand } = await load('nonsense');
    expect(brand.id).toBe('tipoffwatch');
  });

  test('a brand changes the words a reader sees', async () => {
    const sports = await load('tipoffwatch');
    const genre = await load('genrewatch');
    expect(sports.brand.words.event).toBe('game');
    expect(genre.brand.words.event).toBe('release');
    expect(sports.Word.starts).toBe('Kickoff');
    expect(genre.Word.starts).toBe('Out');
  });

  /*
   * Routes are registered from the same `paths` values the link helpers read, so a
   * brand cannot end up linking to a path it does not serve -- the failure mode of
   * keeping a route table and a link helper in two places.
   */
  test('links are built from the same paths routes are registered from', async () => {
    const { href, brand } = await load('genrewatch');
    expect(href.collection('drama')).toBe('/genres/drama');
    expect(href.participant('severance')).toBe('/subjects/severance');
    expect(href.collection('x').startsWith(`/${brand.paths.collection}/`)).toBe(true);
  });

  test('each brand declares which categories and providers it serves', async () => {
    const sports = await load('tipoffwatch');
    const genre = await load('genrewatch');
    // null means "every sport in the database" -- this brand is the sports one.
    expect(sports.brand.categories).toBeNull();
    expect(sports.brand.providers).toEqual(['espn']);
    expect(genre.brand.categories).toContain('tv');
    expect(genre.brand.providers).toContain('tvmaze');
  });

  test('a brand can signpost a category it deliberately does not carry', async () => {
    const genre = await load('genrewatch');
    expect(genre.brand.elsewhere.sports).toBe('https://tipoffwatch.com');
    const sports = await load('tipoffwatch');
    expect(Object.keys(sports.brand.elsewhere)).toEqual([]);
  });
});

describe('what the brand file must not become', () => {
  /*
   * The whole point is that ONE file varies and nothing else branches on which
   * site it is. The moment `brand.id === 'genrewatch'` appears in a route or a
   * view, this stops being a whitelabel and starts being a fork with extra steps.
   */
  test('nothing outside the brand file branches on the brand id', async () => {
    const files = [
      'apps/web/src/app.js',
      'apps/web/src/views/pages.jsx',
      'apps/web/src/views/Layout.jsx',
      'packages/queue/src/workers.js',
      'packages/db/src/queries.js',
    ];
    for (const f of files) {
      const src = await readFile(new URL(`../${f}`, import.meta.url).pathname, 'utf8');
      expect(src).not.toMatch(/brand\.id\s*===/);
      expect(src).not.toContain("=== 'genrewatch'");
    }
  });

  test('reminder correctness is not brand-configurable', async () => {
    const { brand } = await load('genrewatch');
    // Rate limits, offsets and privacy rules are the same everywhere. If one of
    // these ever appears here, a brand can be configured into sending a reminder
    // at the wrong time or leaking something.
    for (const forbidden of ['offsets', 'rateLimit', 'maxLateness', 'secret']) {
      expect(Object.keys(brand)).not.toContain(forbidden);
    }
  });
});
