import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The catalogue module reaches @tipoff/db, which reads the environment at import.
// Static imports hoist above an assignment, so these are pulled in dynamically
// once the variable exists. It needs to be set, not to connect.
process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { CATALOG_ADAPTERS } = await import('../packages/sports/src/catalog.js');
const { collect, outletOf, pickChannels, SECTION_NAMES, SECTIONS, sectionOf } = await import(
  '../packages/sports/src/nichedb.js'
);

const load = async (id) => {
  const saved = process.env.BRAND;
  process.env.BRAND = id;
  try {
    return await import(`../packages/config/src/brands.js?b=${id}&t=${Date.now()}`);
  } finally {
    if (saved === undefined) delete process.env.BRAND;
    else process.env.BRAND = saved;
  }
};

/** A story as nichedb's /api/v1/items actually returns it. */
const gdeltStory = {
  id: 1732512,
  adapter: 'gdelt',
  kind: 'story',
  title: 'Saudi Warehousing & Logistics Expo brings together industry leaders',
  summary: null,
  url: 'https://www.arabnews.com/saudi-arabia/expo-3000957',
  image_url: 'https://assets.example/one.jfif',
  published_at: '2026-09-08T18:15:00.000Z',
  time_known: true,
  precision: 'minute',
  tags: ['news', 'business', 'gdelt', 'economy'],
  data: {
    section: 'business',
    query: 'economy',
    domain: 'arabnews.com',
    country: 'Saudi Arabia',
    language: 'English',
  },
};

const feedStory = {
  id: 1731542,
  adapter: 'newsfeed',
  kind: 'story',
  title: "Beijing Signals Readiness to Talk to Trump's Team",
  summary: 'The Chinese foreign minister spoke by phone.',
  url: 'https://www.wsj.com/articles/beijing-2faddbec',
  image_url: null,
  published_at: '2026-09-08T00:58:00.000Z',
  time_known: true,
  precision: 'minute',
  tags: ['news', 'world', 'dj'],
  data: {
    section: 'world',
    feed: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
    outlet: 'dj',
    categories: ['PAID'],
  },
};

const empty = () => ({ beats: new Map(), outlets: new Map(), events: [] });

describe('the watchnews brand', () => {
  test('reads news in its own vocabulary', async () => {
    const { brand, Word } = await load('watchnews');
    expect(brand.id).toBe('watchnews');
    expect(brand.domain).toBe('watchnews.now');
    expect(brand.words.event).toBe('story');
    expect(brand.words.participant).toBe('outlet');
    expect(brand.words.collection).toBe('section');
    // Not "Kickoff", not "Out" — a story is already published when you see it.
    expect(Word.starts).toBe('Published');
  });

  /*
   * The first cut had a single "news" category above a "beat" tier, which gave
   * a nav with one entry and the URL /news/news. Sections are the category tier
   * precisely so that cannot happen again.
   */
  test('the sections are the categories, so there is no /news/news', async () => {
    const { brand, href } = await load('watchnews');
    expect(brand.categories).toEqual(SECTIONS);
    expect(brand.categories).not.toContain('news');
    expect(brand.categories.length).toBeGreaterThan(5);
    expect(href.category('politics')).toBe('/news/politics');
  });

  test('links are built from the paths routes are registered from', async () => {
    const { href, brand } = await load('watchnews');
    expect(href.collection('world-news')).toBe('/sections/world-news');
    expect(href.participant('bbc-news')).toBe('/outlets/bbc-news');
    expect(href.collection('x').startsWith(`/${brand.paths.collection}/`)).toBe(true);
  });

  test('runs the one provider, and signposts the categories it does not carry', async () => {
    const { brand } = await load('watchnews');
    expect(brand.providers).toEqual(['nichedb']);
    // Sport here is a news desk, not fixtures — tipoffwatch does those properly.
    expect(brand.elsewhere.sports).toBe('https://tipoffwatch.com');
  });

  test('marks stories up as news, not as fixtures', async () => {
    const { brand } = await load('watchnews');
    expect(brand.schema.event).toBe('NewsArticle');
    expect(brand.schema.participant).toBe('NewsMediaOrganization');
  });

  test('carries every copy key the other brands do', async () => {
    const news = await load('watchnews');
    const sports = await load('tipoffwatch');
    const genre = await load('genrewatch');
    expect(Object.keys(news.brand.copy).sort()).toEqual(Object.keys(genre.brand.copy).sort());
    for (const k of Object.keys(sports.brand.copy)) {
      expect(typeof news.brand.copy[k]).toBe('string');
      expect(news.brand.copy[k].length).toBeGreaterThan(0);
    }
  });

  test('no reader-facing copy still calls a section a beat', async () => {
    const { brand } = await load('watchnews');
    for (const [k, v] of Object.entries(brand.copy)) {
      expect(`${k}:${v}`.toLowerCase()).not.toContain('beat');
    }
    expect(brand.description.toLowerCase()).not.toContain('beat');
  });

  /*
   * This brand's events are all in the past, so the countdown pages have nothing
   * to count down to. That has to be said out loud rather than left as an empty
   * page under a sports sentence.
   */
  test('says plainly that news is not scheduled in advance', async () => {
    const { brand } = await load('watchnews');
    expect(brand.copy.soonBlurb).toContain('empty');
    expect(brand.copy.soonEmpty).toMatch(/not announced in advance/);
  });
});

describe('the nichedb provider', () => {
  test('is registered, and its freshness category is one it actually writes', () => {
    const entry = CATALOG_ADAPTERS.find((a) => a.name === 'nichedb');
    expect(entry).toBeTruthy();
    expect(typeof entry.module.fetchAll).toBe('function');
    // lastSyncedAtForCategory looks for leagues whose sport equals this. 'news'
    // matches none of the nine desks, so the interval would never apply.
    expect(SECTIONS).toContain(entry.category);
  });

  test('the section is read from nichedb, not guessed from the text', () => {
    expect(sectionOf(feedStory)).toBe('world');
    expect(sectionOf(gdeltStory)).toBe('business');
    expect(sectionOf({ adapter: 'newsfeed', data: { section: 'politics' } })).toBe('politics');
  });

  test('a row written before sections existed still finds its desk', () => {
    // Nothing re-fetches an old row, so without this every stored story would
    // lose its home the moment sections shipped.
    expect(sectionOf({ adapter: 'gdelt', data: { query: 'election' } })).toBe('politics');
    expect(sectionOf({ adapter: 'gdelt', data: { query: 'economy' } })).toBe('business');
    expect(sectionOf({ adapter: 'newsfeed', data: {} })).toBe('world');
  });

  test('an unknown section is dropped rather than bucketed', () => {
    expect(sectionOf({ adapter: 'gdelt', data: { section: 'astrology' } })).toBeNull();
    expect(sectionOf({ adapter: 'other', data: {} })).toBeNull();
  });

  test('an outlet is the publisher, or the domain when that is all there is', () => {
    expect(outletOf(feedStory)).toEqual({ key: 'dj', name: 'The Wall Street Journal' });
    expect(outletOf(gdeltStory)).toEqual({ key: 'arabnews.com', name: 'arabnews.com' });
    // www. and bare are the same publisher, not two to follow separately.
    expect(outletOf({ data: { domain: 'www.arabnews.com' } }).key).toBe('arabnews.com');
    expect(outletOf({ data: {} })).toBeNull();
  });

  test('the section becomes the category, which is what puts it in the nav', () => {
    const acc = empty();
    collect([gdeltStory, feedStory], acc);
    expect(acc.events).toHaveLength(2);
    const sections = [...acc.beats.values()];
    expect(sections.map((b) => b.category).sort()).toEqual(['business', 'world']);
    expect(sections.map((b) => b.name).sort()).toEqual(['Business', 'World']);
    // Title-casing "us" gets you "Us", which is why there is a name table.
    expect(SECTION_NAMES.us).toBe('US');

    const [story] = acc.events;
    expect(story.kind).toBe('story');
    // 'out' is what stateOf turns into 'post'. Nothing here is ever 'pre'.
    expect(story.state).toBe('out');
    expect(story.startsAt.toISOString()).toBe('2026-09-08T18:15:00.000Z');
    expect(story.venueRegion).toBe('Saudi Arabia');
  });

  test('an outlet publishing on two desks accumulates them rather than forking', () => {
    const acc = empty();
    collect(
      [gdeltStory, { ...gdeltStory, id: 2, data: { ...gdeltStory.data, section: 'politics' } }],
      acc,
    );
    expect(acc.outlets.size).toBe(1);
    expect([...acc.outlets.values()][0].genreKeys).toHaveLength(2);
  });

  test('outlets get a readable slug, not a truncated discriminator', () => {
    const acc = empty();
    collect([feedStory, gdeltStory], acc);
    const slugs = [...acc.outlets.values()].map((o) => o.slug);
    expect(slugs).toContain('the-wall-street-journal');
    expect(slugs).toContain('arabnews-com');
    // The old form kept only the last 8 characters of the key: al-jazeera-ljazeera.
    expect(slugs.some((s) => s.endsWith('-ljazeera'))).toBe(false);
  });

  test('two outlets that would share a slug do not both claim it', () => {
    const acc = empty();
    // A domain under the .news TLD against the publisher named the same thing:
    // teams.slug is UNIQUE, so this would abort the batch rather than look odd.
    collect(
      [
        { ...feedStory, id: 10, data: { section: 'world', outlet: 'bbci' } },
        { ...gdeltStory, id: 11, data: { section: 'world', domain: 'bbc.news' } },
      ],
      acc,
    );
    const slugs = [...acc.outlets.values()].map((o) => o.slug);
    expect(acc.outlets.size).toBe(2);
    expect(new Set(slugs).size).toBe(2);
    expect(slugs).toContain('bbc-news');
  });

  test('a story with no usable timestamp is skipped, not dated to now', () => {
    const acc = empty();
    collect(
      [
        { ...gdeltStory, published_at: null },
        { ...gdeltStory, published_at: 'nonsense' },
      ],
      acc,
    );
    expect(acc.events).toHaveLength(0);
  });

  test('every shipped section has a reader-facing name', () => {
    for (const s of SECTIONS) {
      expect(typeof SECTION_NAMES[s]).toBe('string');
      expect(SECTION_NAMES[s].length).toBeGreaterThan(0);
    }
  });
});

/*
 * The whitelabel only holds if the views actually use it. These strings were
 * hardcoded, so they read correctly on the sports brand and wrongly on the other
 * two: the footer told every reader of watchnews.now that "TipoffWatch is free",
 * and a news section said it had "1 leagues".
 */
describe('no view hardcodes the sports vocabulary', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url).pathname, 'utf8');
  const pages = read('apps/web/src/views/pages.jsx');
  const layout = read('apps/web/src/views/Layout.jsx');

  test('the footer names the brand it is serving', () => {
    expect(layout).not.toContain('TipoffWatch is free');
    expect(layout).toContain('{brand.name} is free');
  });

  test("the browse blurb is per brand, not one site's sentence", () => {
    expect(pages).not.toContain('Pick a sport, then a league');
    expect(pages).toContain('brand.copy.browseBlurb');
  });

  test("counts are pluralised in the brand's own words", () => {
    // "1 leagues" on a news site, and "leagues" at all on two of three brands.
    expect(pages).not.toMatch(/\{s\.leagues\} leagues/);
    expect(pages).not.toMatch(/\{leagues\.length\} leagues\./);
    expect(pages).not.toMatch(/'league' : 'leagues'/);
    expect(pages).not.toMatch(/'team' : 'teams'/);
  });

  test('every brand carries the browse blurb', async () => {
    for (const id of ['tipoffwatch', 'genrewatch', 'watchnews']) {
      const { brand } = await load(id);
      expect(typeof brand.copy.browseBlurb).toBe('string');
      expect(brand.copy.browseBlurb.length).toBeGreaterThan(10);
    }
  });
});

describe('categoryLabel', () => {
  test('an initialism stays an initialism', async () => {
    const { categoryLabel } = await import('../apps/web/src/views/pages.jsx');
    // The whole reason this exists: "us" is a desk, and both "us" and "Us" are wrong.
    expect(categoryLabel('us')).toBe('US');
    expect(categoryLabel('world')).toBe('World');
    expect(categoryLabel('technology')).toBe('Technology');
    expect(categoryLabel('mixed-martial-arts')).toBe('Mixed Martial Arts');
    expect(categoryLabel('')).toBe('');
  });
});

/*
 * The leaks that reached a reader's inbox and home screen, not just a page.
 */
describe('nothing outside the brand file names one site at another', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url).pathname, 'utf8');

  test('the sign-in email is from the site the reader is signing in to', () => {
    const notify = read('packages/notify/src/index.js');
    // Delivered for real on 2026-09-08 with the subject "Your TipoffWatch
    // sign-in link" to someone signing in to watchnews.now.
    expect(notify).not.toContain('TipoffWatch');
    expect(notify).toContain('${brand.name} sign-in link');
  });

  test('the home-screen name and logo are the brand, not the flagship', () => {
    const layout = read('apps/web/src/views/Layout.jsx');
    expect(layout).not.toContain('content="Tipoff"');
    expect(layout).not.toContain('alt="TipoffWatch"');
  });

  test('the footer credits the upstreams this brand actually reads', () => {
    const layout = read('apps/web/src/views/Layout.jsx');
    // A credit naming the wrong upstream is worse than none: a reader takes it
    // as a fact about where what they are looking at came from.
    expect(layout).not.toContain('https://www.espn.com');
    expect(layout).toContain('brand.sources');
  });

  test('every brand declares its own sources and invite reason', async () => {
    for (const id of ['tipoffwatch', 'genrewatch', 'watchnews']) {
      const { brand } = await load(id);
      expect(brand.sources.list.length).toBeGreaterThan(0);
      for (const src of brand.sources.list) {
        expect(src.name.length).toBeGreaterThan(1);
        expect(src.url).toMatch(/^https:\/\//);
      }
      expect(typeof brand.copy.inviteReason).toBe('string');
    }
    const news = await load('watchnews');
    expect(news.brand.sources.list.some((s) => /gdelt/i.test(s.name))).toBe(true);
  });
});

describe('which channels a page offers', () => {
  const ch = (id, name, country) => ({
    id,
    name,
    country,
    norm: name.toLowerCase(),
    streamUrl: `https://cdn/${id}.m3u8`,
  });
  const all = [
    ch('1', 'VIP News', 'US'),
    ch('2', 'BBC News', 'GB'),
    ch('3', 'BBC World News', 'GB'),
    ch('4', 'Sky News', 'GB'),
    ch('5', 'WSOC Now', 'US'),
  ];

  test('a newsroom finds its own channel, not everything with "news" in it', () => {
    // Measured against the real directory, the two-way substring test this
    // replaced answered "BBC News" with VIP News first.
    const picked = pickChannels(all, { outlet: 'BBC News', limit: 3 }).map((c) => c.name);
    expect(picked.slice(0, 2).sort()).toEqual(['BBC News', 'BBC World News']);
    expect(picked[0]).not.toBe('VIP News');
  });

  test('a place-shaped desk is filtered to that country', () => {
    const picked = pickChannels(all, { section: 'us', limit: 9 });
    expect(picked.every((c) => c.country === 'US')).toBe(true);
  });

  test('a page with nothing to match on still gets channels', () => {
    // An empty "where to watch" box is the thing this feature exists to avoid.
    expect(pickChannels(all, { section: 'world', limit: 3 })).toHaveLength(3);
  });

  test('no channel is offered twice, and the limit holds', () => {
    const picked = pickChannels(all, { outlet: 'BBC News', limit: 4 });
    expect(new Set(picked.map((c) => c.id)).size).toBe(picked.length);
    expect(picked.length).toBeLessThanOrEqual(4);
  });
});

/*
 * The player is the house one, and this test exists because it was not.
 *
 * The first cut of the channel page hand-rolled hls.js and added a second copy
 * of it to the tree, next to a package that already does exactly this job and
 * is already a dependency. Worse, it tried native HLS first on the strength of
 * canPlayType -- which lies on Chrome -- so it would have silently played
 * nothing for most readers.
 */
describe('the channel player is @profullstack/player', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url).pathname, 'utf8');

  test('the entry uses the house player rather than a bare engine', () => {
    const entry = read('apps/web/src/client/watch-entry.js');
    expect(entry).toContain("from '@profullstack/player'");
    expect(entry).toContain('createPlayer');
    // The engine ladder belongs to the package. A page that reaches for hls.js
    // or sniffs support itself has started a second ladder that will drift.
    // Matched as CALLS, not as text: the file explains the canPlayType trap in
    // a comment, and a test that cannot tell those apart forbids the comment.
    expect(entry).not.toMatch(/new\s+Hls\(/);
    expect(entry).not.toMatch(/\.canPlayType\(/);
  });

  test('the page mounts a stage and loads the bundle, not a private script', () => {
    const view = read('apps/web/src/views/watch.jsx');
    expect(view).toContain('channel-stage');
    expect(view).toContain('/vendor-watch.js');
    expect(view).toContain('/vendor-player.css');
    expect(view).not.toContain('/vendor-hls.js');
  });

  test('no second copy of hls.js is pinned at the root', () => {
    // The package brings its own, and the build swaps it for the light one.
    const root = JSON.parse(read('package.json'));
    expect(root.dependencies?.['hls.js']).toBeUndefined();
    expect(read('apps/web/package.json')).toContain('@profullstack/player');
  });

  test('the watch bundle gets the same HLS-only treatment as radio', () => {
    const build = read('apps/web/build-client.js');
    expect(build).toContain("['watch-entry.js', 'vendor-watch.js']");
    expect(build).toContain('PLAYER_BUNDLES');
  });
});
