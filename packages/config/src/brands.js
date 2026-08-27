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
  // The top tier, which is what the header nav points at.
  category: 'sport',
  categories: 'sports',
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
  category: 'category',
  categories: 'categories',
  collection: 'genre',
  collections: 'genres',
  participant: 'show',
  participants: 'shows',
  event: 'release',
  events: 'releases',
  starts: 'Out',
  browse: 'Browse by genre',
};

/*
 * Whole sentences, not substituted nouns.
 *
 * "Never miss a {event}." reads fine for a game and badly for a release, and the
 * trick fails completely once grammar differs -- an article, a plural, a verb.
 * Anything longer than a noun phrase lives here in full, per brand, so each site
 * reads like it was written for it rather than generated from a template.
 */

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

    copy: {
      heroTitle: 'Never miss a game.',
      heroBody:
        'Follow any team in the world and get a web notification and an email before they play. ' +
        'Free, no ads, and it works as a calendar feed if you would rather not be notified at all.',
      browse: 'Browse by sport',
      mine: 'My games',
      pushBlurb: 'Get a notification an hour before kickoff, and one minute out.',
      calendarBlurb:
        'Every game you follow, kept up to date automatically, with an alert an hour before kickoff.',
      calendarPrivacy: 'Anyone with this link can see the games you follow.',
      followCollectionBlurb:
        'Following the league notifies you about every fixture in it. Follow individual teams ' +
        'below to hear only about them.',
      emptyParticipants:
        "No teams recorded yet -- they appear once this league's fixtures are synced.",
      emptyFollows: "You're not following anything yet.",
      notFound: "Back to today's games",
      liveTitle: 'Live now',
      liveBlurb:
        'Games in progress across every league, biggest competitions first. No account and ' +
        'nothing to follow -- open one and watch.',
      liveEmpty: 'Nothing is in progress right now. This fills up around kickoff.',
      soonTitle: 'Starting soon',
      soonBlurb:
        'Kicking off in the next four hours, soonest first. Enough warning to find it, ' +
        'close enough that you do not have to remember.',
      soonEmpty: 'Nothing kicks off in the next four hours.',

      /*
       * The paid tier, in this brand's own words.
       *
       * Copy only. What the tier actually unlocks is decided in code and is the
       * same on every brand -- a feature list that a brand file could disagree
       * with is a promise a reader can be sold and not given.
       */
      premiumTitle: 'Premium',
      premiumBlurb:
        'Following teams, reminders and calendar feeds stay free and always will. ' +
        'Premium is for the parts that cost us something to run.',
      premiumShare: 'Share your line with the people you choose, instead of the whole site.',
      premiumHistory:
        'Keep every message you have ever sent or received, not just the recent ones.',
      premiumInvites: 'Earn a share of what the people you bring in spend.',
    },
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

    copy: {
      heroTitle: 'Know before it drops.',
      heroBody:
        'Follow a genre or a name -- a show, a film, an artist, a rocket -- and we will tell you ' +
        'before it is out. Free, no ads, and it works as a calendar feed if you would rather not ' +
        'be notified at all.',
      browse: 'Browse by genre',
      mine: 'My calendar',
      pushBlurb:
        'Get told before something you follow is out. An hour ahead for anything with a start ' +
        'time, the day before for anything with only a date.',
      calendarBlurb:
        'Everything you follow, kept up to date automatically. Anything with only a release date ' +
        'arrives as an all-day entry rather than a made-up time.',
      calendarPrivacy: 'Anyone with this link can see everything you follow.',
      followCollectionBlurb:
        'Following the genre tells you about everything filed under it. Follow individual names ' +
        'below to hear only about them.',
      emptyParticipants: 'Nothing filed here yet -- it appears once this genre is synced.',
      emptyFollows: "You're not following anything yet.",
      liveTitle: 'Happening now',
      liveBlurb:
        'Under way right now -- a launch, a premiere, anything with a start and an end rather ' +
        'than just a date.',
      liveEmpty: 'Nothing is under way right now.',
      soonTitle: 'Out in the next few hours',
      soonBlurb:
        'Anything with a real start time landing in the next four hours, soonest first. ' +
        'Releases carrying only a date are not here -- they have no hour to count down to.',
      soonEmpty: 'Nothing with a start time lands in the next four hours.',
      notFound: 'Back to what is coming up',

      premiumTitle: 'Premium',
      premiumBlurb:
        'Following names, reminders and calendar feeds stay free and always will. ' +
        'Premium is for the parts that cost us something to run.',
      premiumShare: 'Share your line with the people you choose, instead of the whole site.',
      premiumHistory:
        'Keep every message you have ever sent or received, not just the recent ones.',
      premiumInvites: 'Earn a share of what the people you bring in spend.',
    },
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
