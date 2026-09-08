import { brand, config } from '@tipoff/config';
import { marketsOf } from './markets.js';

/**
 * Structured data, as plain objects.
 *
 * Builders here, rendering in the Layout. Keeping them apart is what lets a test
 * assert the shape of a fixture's markup without rendering a page, and it keeps
 * the escaping decision (below) in exactly one place.
 *
 * Everything is brand-driven. A fixture on the sports site is a SportsEvent and
 * on the sibling it is a plain Event, because a release is not a game -- see
 * `brand.schema`.
 */

const url = (path) => `${config.siteUrl}${path}`;

/**
 * Serialise for embedding in a <script> data block.
 *
 * `</script>` inside a string value would end the element early and drop the rest
 * of the page into the document as text; escaping `<` is the whole fix and it has
 * to happen on every value, which is why nothing else builds this string.
 */
export const serialise = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

/** Drop keys whose value is null or undefined, so no empty property is emitted. */
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));

/**
 * The site itself, on every page.
 *
 * Two nodes rather than one: `Organization` is what an answer engine resolves the
 * name "TipoffWatch" to, and `WebSite` is what carries the search action. They
 * reference each other by @id so the two are understood as one entity rather than
 * two things that happen to share a name.
 */
export const siteGraph = () => [
  compact({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': url('/#organization'),
    name: brand.name,
    url: url('/'),
    description: brand.description,
    logo: url('/icons/icon-512x512.png'),
    email: config.contactEmail,
  }),
  {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': url('/#website'),
    name: brand.name,
    url: url('/'),
    description: brand.description,
    inLanguage: 'en',
    publisher: { '@id': url('/#organization') },
    /*
     * The header search box, declared. It is a plain GET form at /search, which is
     * exactly what this markup describes -- so an engine that offers a search box
     * against the site sends readers somewhere that already works.
     */
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: url('/search?q={search_term_string}'),
      },
      'query-input': 'required name=search_term_string',
    },
  },
];

/** schema.org's vocabulary for the three states the provider gives us. */
const EVENT_STATUS = {
  pre: 'https://schema.org/EventScheduled',
  in: 'https://schema.org/EventScheduled',
  post: 'https://schema.org/EventScheduled',
};

const place = (event) => {
  if (!event.venue) return null;
  // The city and region are separate columns, and either may be missing. An
  // address object with nothing in it is worse than no address at all.
  const address = compact({
    '@type': 'PostalAddress',
    addressLocality: event.venue_city ?? null,
    addressRegion: event.venue_region ?? null,
  });
  return compact({
    '@type': 'Place',
    name: event.venue,
    address: Object.keys(address).length > 1 ? address : null,
  });
};

const competitor = (name, slug, logo) =>
  compact({
    '@type': brand.schema.participant,
    name,
    url: slug ? url(`/${brand.paths.participant}/${slug}`) : null,
    logo: logo ?? null,
  });

/**
 * One fixture.
 *
 * The page already carries every field this needs in visible HTML -- the matchup,
 * the kickoff time in a <time datetime>, the venue and the league. The markup adds
 * nothing a reader cannot see; it just says which is which, so "what time do the
 * Yankees play" can be answered from this page rather than guessed at.
 */
export const eventNode = (event) => {
  const teams = [
    event.away_name ? competitor(event.away_name, event.away_slug, event.away_logo) : null,
    event.home_name ? competitor(event.home_name, event.home_slug, event.home_logo) : null,
  ].filter(Boolean);

  return compact({
    '@context': 'https://schema.org',
    '@type': brand.schema.event,
    '@id': url(`/events/${event.id}#event`),
    name: event.name,
    url: url(`/events/${event.id}`),
    /*
     * Some fixtures have a date and no hour -- a release with no announced time, a
     * tournament day. The column says which, and a made-up midnight kickoff
     * published as fact is worse than a date on its own.
     */
    startDate: event.time_known === false ? isoDay(event.starts_at) : iso(event.starts_at),
    eventStatus: EVENT_STATUS[event.state] ?? EVENT_STATUS.pre,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: place(event),
    // Both sides are competitors; `homeTeam`/`awayTeam` only make sense when there
    // are two of them, which a grand prix or a fight card does not have.
    competitor: teams.length ? teams : null,
    awayTeam: teams.length === 2 ? teams[0] : null,
    homeTeam: teams.length === 2 ? teams[1] : null,
    superEvent: event.league_slug
      ? compact({
          '@type': brand.schema.collection,
          name: event.league_name,
          url: url(`/${brand.paths.collection}/${event.league_slug}`),
        })
      : null,
    // Every fixture page is free to read, which is a thing an engine will
    // otherwise assume it has to ask about.
    isAccessibleForFree: true,
  });
};

const iso = (at) => new Date(at).toISOString();
const isoDay = (at) => new Date(at).toISOString().slice(0, 10);

/**
 * "Where to watch", said in the vocabulary an answer engine reads.
 *
 * The single most-asked question about a fixture is which channel it is on, and
 * until now the only machine-readable thing on the page was the kickoff time. The
 * listing was rendered as visible text and nothing else, so "what channel is the
 * Yankees game on" could be answered from this page only by an engine willing to
 * guess at prose.
 *
 * An `ItemList` rather than `broadcastOfEvent` on the fixture: what the provider
 * gives us is a set of rights holders per country, not a scheduled broadcast with
 * a start time on a named service, and publishing the second when we only know the
 * first would be inventing a fact. Each entry is a `BroadcastService` with the
 * country it serves, which is exactly the claim the page makes in words.
 *
 * EVERY market and EVERY channel in it, in the order they render. The list is
 * flat rather than one list per country because an ItemList of ItemLists is read
 * by almost nothing, and `areaServed` already carries which country a listing is
 * true in -- an ESPN listing is a US listing, and a name with no country attached
 * is the one way this could mislead.
 *
 * Published on a single-market fixture too, where the "Where to watch" section
 * stands down in favour of the stat tile above it. The names are on the page
 * either way -- the tile carries them -- so this still only says which visible
 * fact is the broadcaster, which is the rule every other node here follows.
 */
export const watchListNode = (event) => {
  const markets = marketsOf(event);
  if (markets.length === 0) return null;

  const items = [];
  for (const market of markets) {
    // A provider occasionally repeats a name within one country. Deduped per
    // market rather than globally: the same broadcaster in two countries is two
    // listings, and collapsing those would drop a country off the list.
    for (const name of [...new Set(market.channels)]) {
      items.push({
        '@type': 'ListItem',
        position: items.length + 1,
        item: {
          '@type': 'BroadcastService',
          name,
          areaServed: { '@type': 'Country', name: market.country },
        },
      });
    }
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': url(`/events/${event.id}#watch`),
    name: `Where to watch ${event.name}`,
    // Tied to the fixture node above it by @id, so the list is understood as this
    // game's broadcasters rather than a list of channels that happens to share a
    // page with a game.
    about: { '@id': url(`/events/${event.id}#event`) },
    // The order is the provider's, which carries no ranking. Saying so stops an
    // engine reading the first entry as the primary broadcaster.
    itemListOrder: 'https://schema.org/ItemListUnordered',
    numberOfItems: items.length,
    itemListElement: items,
  };
};

/**
 * A trail, matching the <ol class="crumbs"> already on the page.
 *
 * `items` is [label, href] pairs; the last one is the page itself and carries no
 * link, exactly as it renders.
 */
export const breadcrumbNode = (items) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, path], i) =>
    compact({
      '@type': 'ListItem',
      position: i + 1,
      name,
      item: path ? url(path) : null,
    }),
  ),
});

/**
 * Questions and answers that are already on the page.
 *
 * The About page has been written as question headings since it was first
 * published; this only marks up what is there. Inventing an FAQ to carry the
 * markup would be the other way round, and would put text on the site that exists
 * for a crawler rather than a reader.
 */
export const faqNode = (pairs) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: pairs.map(([question, answer]) => ({
    '@type': 'Question',
    name: question,
    acceptedAnswer: { '@type': 'Answer', text: answer },
  })),
});
