/**
 * The whitelabel override point.
 *
 * One codebase, several sites. Everything that differs between them lives in this
 * file and nothing else in the repo branches on which site it is -- so a fix lands
 * once and every brand gets it, and a new brand is an entry here rather than a
 * fork.
 *
 * What made this possible is that the schema already fits. `leagues` is a
 * collection of things, `teams` are the participants, `team_leagues` is already
 * many-to-many, and home/away are already nullable because a race and a fight card
 * have no two sides. A television series in a genre is that same shape wearing
 * different words -- so the words are what varies here, not the tables.
 *
 * What must NOT go in here: anything a reader could be harmed by getting wrong.
 * Rate limits, reminder correctness and privacy rules are the same everywhere and
 * live in code.
 */

/**
 * @typedef {object} Brand
 * @property {string} id            matches the BRAND env var
 * @property {string} name          how the site calls itself
 * @property {string} domain        canonical host, for copy that names it
 * @property {string} tagline       the one line under the logo
 * @property {string} description   the meta description default
 * @property {object} words         vocabulary; see the note below
 * @property {object} paths         URL segments, used to REGISTER routes and to
 *                                  build links, so the two can never disagree
 * @property {string[]|null} categories  which `sport` values this brand serves;
 *                                  null means every one in the database
 * @property {string[]} providers   which sync adapters run
 * @property {Record<string,string>} elsewhere  categories this brand deliberately
 *                                  does not carry, and where to send people
 */

/*
 * Vocabulary, not translation.
 *
 * These are the words a reader sees for the three catalogue tiers. They are
 * deliberately NOT applied by find-and-replace over the codebase: the identifiers
 * stay `league` and `team` everywhere, because renaming them is what turns a
 * whitelabel into a fork that can never merge from upstream again.
 */
const SPORTS_WORDS = {
  collection: 'league',
  collections: 'leagues',
  participant: 'team',
  participants: 'teams',
  event: 'game',
  events: 'games',
  starts: 'Kickoff',
  browse: 'Browse by sport',
};

const GENRE_WORDS = {
  collection: 'genre',
  collections: 'genres',
  participant: 'show',
  participants: 'shows',
  event: 'release',
  events: 'releases',
  starts: 'Out',
  browse: 'Browse by genre',
};

/** @type {Record<string, Brand>} */
const BRANDS = {
  tipoffwatch: {
    id: 'tipoffwatch',
    name: 'TipoffWatch',
    domain: 'tipoffwatch.com',
    tagline: 'Know before they play.',
    description: 'Follow any team in the world and get told before they play. Free.',
    words: SPORTS_WORDS,
    paths: { category: 'sports', collection: 'leagues', participant: 'teams' },
    // Every sport in the database. This brand is the sports one.
    categories: null,
    providers: ['espn'],
    elsewhere: {},
  },

  genrewatch: {
    id: 'genrewatch',
    name: 'GenreWatch',
    domain: 'genrewatch.com',
    tagline: 'Know before it drops.',
    description: 'Follow a genre or a name and get told before it drops. Free.',
    words: GENRE_WORDS,
    paths: { category: 'categories', collection: 'genres', participant: 'subjects' },
    categories: ['tv', 'film', 'anime', 'music', 'space'],
    providers: ['tvmaze', 'anilist', 'tmdb', 'musicbrainz', 'spacedevs'],
    /*
     * Sport is a link, not a section.
     *
     * The sibling site does fixtures, live scores and per-market broadcast
     * listings properly. A thin second copy here would be worse than a signpost,
     * and because both run this same code the signpost is honest about it.
     */
    elsewhere: { sports: 'https://tipoffwatch.com' },
  },
};

/**
 * The brand this process is serving.
 *
 * Read once at import like everything else in config. An unknown BRAND falls back
 * to the default rather than throwing: a typo should serve the flagship site, not
 * take the deployment down.
 */
export const brand = BRANDS[process.env.BRAND ?? ''] ?? BRANDS.tipoffwatch;

/** Every brand, for tests and for the odd tool that wants to enumerate them. */
export const brands = BRANDS;

/**
 * Link builders.
 *
 * Routes are REGISTERED from the same `paths` values these read, so a brand cannot
 * end up with links pointing at paths it does not serve -- which is the failure
 * mode of keeping a route table and a link helper in two places.
 */
export const href = {
  category: (slug) => `/${brand.paths.category}${slug ? `/${slug}` : ''}`,
  collection: (slug) => `/${brand.paths.collection}/${slug}`,
  participant: (slug) => `/${brand.paths.participant}/${slug}`,
};

/** Capitalised vocabulary, for a word that starts a sentence or a heading. */
export const Word = Object.fromEntries(
  Object.entries(brand.words).map(([k, v]) => [k, v.charAt(0).toUpperCase() + v.slice(1)]),
);
