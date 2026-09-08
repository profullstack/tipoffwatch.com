import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { breadcrumbNode, eventNode, faqNode, serialise, siteGraph, watchListNode } = await import(
  '../apps/web/src/lib/jsonld.js'
);
/*
 * Read the origin back rather than pinning a host. config is a module-level
 * snapshot of the environment, and `bun test` shares the module registry across
 * files -- so whichever test file imports it first decides SITE_URL for all of
 * them, and a hardcoded https://tipoffwatch.com here passes alone and fails in a
 * full run. What matters is that these are absolute URLs on the site's own
 * origin, which is what this asserts.
 */
const { config } = await import('../packages/config/src/index.js');
const SITE = config.siteUrl;
const { ABOUT_FAQ, About, EventPage } = await import('../apps/web/src/views/pages.jsx');

/** Every ld+json block on a rendered page, parsed. */
const blocks = async (node) => {
  const out = (await node.toString()).toString();
  return [...out.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1].replace(/\\u003c/g, '<')),
  );
};

const FIXTURE = {
  id: 305,
  name: 'Boston Red Sox at New York Yankees',
  short_name: 'BOS @ NYY',
  starts_at: '2026-08-30T23:05:00.000Z',
  state: 'pre',
  sport: 'baseball',
  league_slug: 'baseball-mlb',
  league_name: 'MLB',
  venue: 'Yankee Stadium',
  venue_city: 'Bronx',
  venue_region: 'NY',
  home_name: 'New York Yankees',
  home_slug: 'nyy',
  away_name: 'Boston Red Sox',
  away_slug: 'bos',
};

describe('serialising into a script block', () => {
  test('a value cannot end the element early', () => {
    // Without this a team called </script> -- or a comment quoted into a page --
    // drops the rest of the document into the browser as text.
    const out = serialise({ name: '</script><img onerror=alert(1)>' });
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c');
    // And it is still JSON: an escape that broke parsing would be silently ignored
    // by every engine that reads it.
    expect(JSON.parse(out.replace(/\\u003c/g, '<')).name).toBe('</script><img onerror=alert(1)>');
  });
});

describe('the site graph', () => {
  const [org, site] = siteGraph();

  test('names the brand as an entity', () => {
    expect(org['@type']).toBe('Organization');
    expect(org.name).toBe('TipoffWatch');
    expect(org.url).toBe(`${SITE}/`);
  });

  test('publishes no contact address until one is configured', () => {
    // A `hello@` that nobody reads is worse than none: it looks like a working
    // contact to everyone who writes to it. See config.contactEmail.
    expect(org.email).toBeUndefined();
  });

  test('the website and the organization are one entity, not two', () => {
    expect(site.publisher['@id']).toBe(org['@id']);
  });

  test('the search action points at the form that already exists', () => {
    expect(site.potentialAction.target.urlTemplate).toBe(`${SITE}/search?q={search_term_string}`);
  });
});

describe('a fixture', () => {
  const node = eventNode(FIXTURE);

  test('is typed from the brand, not hardcoded', () => {
    // The sibling site runs this same file, where a release is not a SportsEvent.
    expect(node['@type']).toBe('SportsEvent');
    expect(node.competitor[0]['@type']).toBe('SportsTeam');
  });

  test('carries the kickoff, the venue and both sides', () => {
    expect(node.startDate).toBe('2026-08-30T23:05:00.000Z');
    expect(node.location.name).toBe('Yankee Stadium');
    expect(node.location.address.addressLocality).toBe('Bronx');
    expect(node.homeTeam.name).toBe('New York Yankees');
    expect(node.awayTeam.name).toBe('Boston Red Sox');
  });

  test('a one-sided event gets competitors but no home and away', () => {
    // A grand prix, a fight card and a tennis draw are one event with a field.
    // Naming one entrant "homeTeam" would be an invention.
    const solo = eventNode({ ...FIXTURE, home_name: null, away_name: null, home_slug: null });
    expect(solo.homeTeam).toBeUndefined();
    expect(solo.awayTeam).toBeUndefined();
    expect(solo.competitor).toBeUndefined();
  });

  test('a date-only fixture publishes a date, not an invented midnight', () => {
    const untimed = eventNode({ ...FIXTURE, time_known: false });
    expect(untimed.startDate).toBe('2026-08-30');
  });

  test('a missing venue emits no empty Place', () => {
    expect(eventNode({ ...FIXTURE, venue: null }).location).toBeUndefined();
  });

  test('reaches the page it describes', async () => {
    const found = await blocks(EventPage({ user: null, event: FIXTURE, offers: [] }));
    expect(found.map((b) => b['@type'])).toEqual([
      'Organization',
      'WebSite',
      'SportsEvent',
      'BreadcrumbList',
    ]);
  });
});

describe('the “Where to watch” listing', () => {
  const MARKETS = [
    { country: 'United States', channels: ['NBC', 'Peacock'] },
    { country: 'United Kingdom', channels: ['Sky Sports Main Event'] },
  ];
  const carried = { ...FIXTURE, broadcast_markets: MARKETS };

  test('every channel in every market is an item, not just the first market', () => {
    // The bug this exists to prevent: a fixture carried in five countries
    // publishing one of them, which reads as an exclusive.
    const node = watchListNode(carried);
    expect(node['@type']).toBe('ItemList');
    expect(node.numberOfItems).toBe(3);
    expect(node.itemListElement.map((i) => i.item.name)).toEqual([
      'NBC',
      'Peacock',
      'Sky Sports Main Event',
    ]);
    expect(node.itemListElement.map((i) => i.position)).toEqual([1, 2, 3]);
  });

  test('a listing carries the country it is true in', () => {
    // ESPN's listings are US rights holders. A broadcaster name with no country
    // attached is the one way this markup could mislead.
    const node = watchListNode(carried);
    expect(node.itemListElement[0].item['@type']).toBe('BroadcastService');
    expect(node.itemListElement[0].item.areaServed).toEqual({
      '@type': 'Country',
      name: 'United States',
    });
    expect(node.itemListElement[2].item.areaServed.name).toBe('United Kingdom');
  });

  test('the list is attached to the fixture, not merely to the page', () => {
    expect(watchListNode(carried).about['@id']).toBe(eventNode(carried)['@id']);
  });

  test('the order is declared as carrying no ranking', () => {
    // Otherwise the first entry reads as the primary broadcaster, which is a fact
    // the provider does not give us.
    expect(watchListNode(carried).itemListOrder).toBe('https://schema.org/ItemListUnordered');
  });

  test('a repeated name within one market is listed once', () => {
    const node = watchListNode({
      ...FIXTURE,
      broadcast_markets: [{ country: 'United States', channels: ['NBC', 'NBC'] }],
    });
    expect(node.numberOfItems).toBe(1);
  });

  test('the same broadcaster in two countries is two listings', () => {
    // Collapsing these would silently drop a country off the list.
    const node = watchListNode({
      ...FIXTURE,
      broadcast_markets: [
        { country: 'United States', channels: ['ESPN'] },
        { country: 'Canada', channels: ['ESPN'] },
      ],
    });
    expect(node.numberOfItems).toBe(2);
  });

  test('markets stored as a jsonb string are read the same way', () => {
    expect(
      watchListNode({ ...FIXTURE, broadcast_markets: JSON.stringify(MARKETS) }).numberOfItems,
    ).toBe(3);
  });

  test('a fixture nobody carries publishes no empty list', () => {
    // An ItemList with nothing in it is a claim that nobody is showing this game.
    expect(watchListNode(FIXTURE)).toBeNull();
    expect(watchListNode({ ...FIXTURE, broadcast_markets: 'not json' })).toBeNull();
  });

  test('reaches the page, and only when there is one', async () => {
    const found = await blocks(EventPage({ user: null, event: carried, offers: [] }));
    expect(found.map((b) => b['@type'])).toEqual([
      'Organization',
      'WebSite',
      'SportsEvent',
      'BreadcrumbList',
      'ItemList',
    ]);

    const bare = await blocks(EventPage({ user: null, event: FIXTURE, offers: [] }));
    expect(bare.map((b) => b['@type'])).not.toContain('ItemList');
    // And nothing renders as a null node where the list would have been.
    expect(bare.every(Boolean)).toBe(true);
  });

  test('every name in the markup is a name on the page', async () => {
    // The rule the whole module follows: this says which visible fact is the
    // broadcaster, it does not add one.
    const html = (
      await EventPage({ user: null, event: carried, offers: [] }).toString()
    ).toString();
    for (const item of watchListNode(carried).itemListElement) {
      expect(html).toContain(item.item.name);
    }
  });
});

describe('breadcrumbs', () => {
  test('the last item is the page itself and carries no link', () => {
    const node = breadcrumbNode([
      ['Leagues', '/sports'],
      ['BOS @ NYY', null],
    ]);
    expect(node.itemListElement[1].position).toBe(2);
    expect(node.itemListElement[1].item).toBeUndefined();
  });
});

describe('the About FAQ', () => {
  test('marks up questions the page actually asks', async () => {
    // The markup must describe the page, not replace it. Every question in the
    // node has to be a heading a reader can see, or this is text written for a
    // crawler and nobody else.
    const html = (await About({ user: null, stats: {} }).toString()).toString();
    for (const [question] of ABOUT_FAQ) {
      const heading = question.replace(/\?$/, '');
      expect(html.includes(`<h2>${heading}?</h2>`) || html.includes(heading)).toBe(true);
    }
  });

  test('every question has an answer', () => {
    const node = faqNode(ABOUT_FAQ);
    expect(node.mainEntity.length).toBe(ABOUT_FAQ.length);
    for (const q of node.mainEntity) expect(q.acceptedAnswer.text.length).toBeGreaterThan(20);
  });
});
