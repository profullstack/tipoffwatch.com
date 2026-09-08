import { describe, expect, test } from 'bun:test';

// The catalogue module reaches @tipoff/db, which reads the environment at import.
// Static imports hoist above an assignment, so these are pulled in dynamically
// once the variable exists. It needs to be set, not to connect.
process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { CATALOG_ADAPTERS } = await import('../packages/sports/src/catalog.js');
const { beatOf, collect, outletOf } = await import('../packages/sports/src/nichedb.js');

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
  tags: ['news', 'gdelt', 'economy'],
  data: { query: 'economy', domain: 'arabnews.com', country: 'Saudi Arabia', language: 'English' },
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
  tags: ['news', 'dj'],
  data: { feed: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', outlet: 'dj', categories: ['PAID'] },
};

const empty = () => ({ beats: new Map(), outlets: new Map(), events: [] });

describe('the watchnews brand', () => {
  test('reads news in its own vocabulary', async () => {
    const { brand, Word } = await load('watchnews');
    expect(brand.id).toBe('watchnews');
    expect(brand.domain).toBe('watchnews.now');
    expect(brand.words.event).toBe('story');
    expect(brand.words.participant).toBe('outlet');
    expect(brand.words.collection).toBe('beat');
    // Not "Kickoff", not "Out" — a story is already published when you see it.
    expect(Word.starts).toBe('Published');
  });

  test('links are built from the paths routes are registered from', async () => {
    const { href, brand } = await load('watchnews');
    expect(href.collection('world-news')).toBe('/beats/world-news');
    expect(href.participant('bbc-news')).toBe('/outlets/bbc-news');
    expect(href.collection('x').startsWith(`/${brand.paths.collection}/`)).toBe(true);
  });

  test('serves only the news category, from the one provider', async () => {
    const { brand } = await load('watchnews');
    expect(brand.categories).toEqual(['news']);
    expect(brand.providers).toEqual(['nichedb']);
    // Sports and film are real sites, so signpost rather than carry a thin copy.
    expect(brand.elsewhere.sports).toBe('https://tipoffwatch.com');
  });

  test('marks stories up as news, not as fixtures', async () => {
    const { brand } = await load('watchnews');
    expect(brand.schema.event).toBe('NewsArticle');
    expect(brand.schema.participant).toBe('NewsMediaOrganization');
  });

  /*
   * The copy object is the whole reason whole sentences live in the brand file.
   * A brand missing a key renders `undefined` at a reader, so every brand must
   * carry exactly the same set.
   */
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
  test('is registered as the news catalogue adapter', () => {
    const entry = CATALOG_ADAPTERS.find((a) => a.name === 'nichedb');
    expect(entry).toBeTruthy();
    expect(entry.category).toBe('news');
    expect(typeof entry.module.fetchAll).toBe('function');
  });

  test('GDELT states its beat; a newsroom feed is a world desk', () => {
    expect(beatOf(gdeltStory)).toBe('economy');
    expect(beatOf(feedStory)).toBe('world');
    expect(beatOf({ adapter: 'other', data: {} })).toBeNull();
  });

  test('an outlet is the publisher, or the domain when that is all there is', () => {
    expect(outletOf(feedStory)).toEqual({ key: 'dj', name: 'The Wall Street Journal' });
    expect(outletOf(gdeltStory)).toEqual({ key: 'arabnews.com', name: 'arabnews.com' });
    // www. and bare are the same publisher, not two to follow separately.
    expect(outletOf({ data: { domain: 'www.arabnews.com' } }).key).toBe('arabnews.com');
    expect(outletOf({ data: {} })).toBeNull();
  });

  test('a story becomes an event with one side, filed under its beat', () => {
    const acc = empty();
    collect([gdeltStory, feedStory], acc);
    expect(acc.events).toHaveLength(2);
    expect([...acc.beats.values()].map((b) => b.name).sort()).toEqual(['Economy', 'World']);
    expect([...acc.beats.values()].every((b) => b.category === 'news')).toBe(true);

    const [story] = acc.events;
    expect(story.kind).toBe('story');
    // 'out' is what stateOf turns into 'post'. Nothing here is ever 'pre'.
    expect(story.state).toBe('out');
    expect(story.startsAt.toISOString()).toBe('2026-09-08T18:15:00.000Z');
    expect(story.subjectKey).toBe(acc.outlets.get(story.subjectKey).providerKey);
    expect(story.venueRegion).toBe('Saudi Arabia');
  });

  test('an outlet publishing on two beats accumulates them rather than forking', () => {
    const acc = empty();
    collect(
      [gdeltStory, { ...gdeltStory, id: 2, data: { ...gdeltStory.data, query: 'election' } }],
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
        { ...feedStory, id: 10, data: { outlet: 'bbci' } },
        { ...gdeltStory, id: 11, data: { query: 'world', domain: 'bbc.news' } },
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

  test('an item with no beat or no outlet is skipped rather than bucketed', () => {
    const acc = empty();
    collect([{ ...gdeltStory, adapter: 'other', data: { domain: 'x.com' } }], acc);
    expect(acc.events).toHaveLength(0);
  });
});
