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

/*
 * News has one axis where sport has two.
 *
 * A sport contains leagues which contain teams. A news section does not contain
 * sub-sections anybody browses -- Politics is Politics -- so the category and
 * collection tiers carry the same word here rather than inventing a middle one.
 * That is a fact about news, not a shortcut: the first cut of this brand had a
 * single "news" category above a "beat" tier, which produced the URL
 * /news/news and a nav with one entry in it.
 */
const NEWS_WORDS = {
  category: 'section',
  categories: 'sections',
  collection: 'section',
  collections: 'sections',
  participant: 'outlet',
  participants: 'outlets',
  event: 'story',
  events: 'stories',
  // Not "Kickoff" and not "Out": a story is already published when you see it.
  starts: 'Published',
  browse: 'Browse by section',
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
      browseBlurb: 'Pick a sport, then a league, then follow the teams you care about.',
      inviteReason: 'keep track of when their teams play',
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
      resultsTitle: 'Final scores',
      resultsBlurb:
        'Games that have finished, most recent first. Open one for the box score, the ' +
        'scoring plays and how it was called beforehand.',
      resultsEmpty: 'Nothing has finished in the last week.',

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
    /*
     * schema.org vocabulary for this brand's structured data.
     *
     * A fixture is a SportsEvent and a competitor is a SportsTeam; on the sibling
     * site the same rows are a release and a title, and calling those a
     * SportsEvent would be a lie told to every answer engine that reads it. So the
     * TYPE is per brand while the shape of the markup is shared, the same way the
     * vocabulary above works.
     */
    schema: { event: 'SportsEvent', participant: 'SportsTeam', collection: 'SportsOrganization' },
    sources: {
      lead: 'Schedule data from',
      list: [
        { name: "ESPN's public API", url: 'https://www.espn.com' },
        { name: 'the Live Tennis API', url: 'https://livetennisapi.com' },
      ],
      note: 'Not affiliated with either.',
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
      browseBlurb: 'Pick a category, then a genre, then follow the names you care about.',
      inviteReason: 'keep track of what is coming out',
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
      resultsTitle: 'Already out',
      resultsBlurb: 'Finished and released, most recent first.',
      resultsEmpty: 'Nothing has wrapped up in the last week.',
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
    // A release is an Event with a start; the thing being released is a
    // CreativeWork, and a genre is a collection of them rather than a league.
    schema: { event: 'Event', participant: 'CreativeWork', collection: 'Thing' },
    sources: {
      lead: 'Release dates from',
      list: [
        { name: 'TVmaze', url: 'https://www.tvmaze.com' },
        { name: 'TMDB', url: 'https://www.themoviedb.org' },
        { name: 'AniList', url: 'https://anilist.co' },
        { name: 'MusicBrainz', url: 'https://musicbrainz.org' },
        { name: 'the Launch Library', url: 'https://thespacedevs.com' },
      ],
      note: 'Not affiliated with any of them.',
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

  /*
   * The one brand whose events are in the past.
   *
   * A fixture is something that will happen and a release is something that will
   * drop; a story has already been published by the time anyone can read it. The
   * schema takes that without complaint -- `starts_at` is just a timestamp -- but
   * the COPY cannot pretend otherwise, so the pages that exist to count down say
   * plainly that news does not announce itself in advance rather than sitting
   * empty with a sports sentence over them. That honesty is the whole reason
   * whole sentences live in this file instead of substituted nouns.
   */
  watchnews: {
    id: 'watchnews',
    name: 'WatchNews',
    domain: 'watchnews.now',
    tagline: 'Know who reported it.',
    description:
      'Follow a section or a newsroom and read what they actually published, from free sources only. Free.',
    words: NEWS_WORDS,
    paths: { category: 'news', collection: 'sections', participant: 'outlets' },
    /*
     * The desks, and the order a reader meets them. These are `sport` column
     * values, written by the nichedb provider, so this list mirrors what that
     * collection actually produces rather than describing an ambition.
     */
    categories: [
      'world',
      'us',
      'politics',
      'business',
      'technology',
      'science',
      'health',
      'sport',
      'climate',
    ],

    copy: {
      heroTitle: 'Follow the desk, not the algorithm.',
      heroBody:
        'Pick a section or a newsroom and see what it published, newest first. Wire copy read ' +
        'straight from the publishers themselves plus worldwide coverage in 65 languages, so ' +
        'you can watch one story land across a hundred outlets at once. Free, no ads, and no ' +
        'account needed to read.',
      browse: 'Browse by section',
      browseBlurb: 'Pick a section, then a newsroom, and follow the ones you actually read.',
      inviteReason: 'follow the desks and newsrooms they actually read',
      mine: 'My sections',
      pushBlurb: 'Get a notification when a newsroom you follow publishes.',
      calendarBlurb: 'Everything you follow as a calendar feed, filed on the day it was published.',
      calendarPrivacy: 'Anyone with this link can see the sections and outlets you follow.',
      followCollectionBlurb:
        'Following the section covers every outlet reporting it. Follow individual newsrooms ' +
        'below to hear only from them.',
      emptyParticipants: 'No outlets on this section yet -- they appear as soon as one publishes.',
      emptyFollows: "You're not following anything yet.",

      /*
       * News has no fixture list. Rather than dress these pages in a countdown
       * they can never have, they say what is true and point at the page that
       * does have something on it.
       */
      liveTitle: 'Breaking',
      liveBlurb:
        'News does not file a start time, so nothing is ever "in progress" here. What we can ' +
        'tell you is what landed in the last hour.',
      liveEmpty: 'Nothing has landed in the last hour. The latest is on the front page.',
      soonTitle: 'Coming up',
      soonBlurb:
        'Deliberately empty. Every other site running this code counts down to a fixture or a ' +
        'release; a story is only news once it is published, so there is nothing here to ' +
        'count down to.',
      soonEmpty: 'Nothing is scheduled -- news is not announced in advance. Try the front page.',
      resultsTitle: 'Latest',
      resultsBlurb: 'Everything published in the last week, newest first, across every section.',
      resultsEmpty:
        'Nothing published in the last week, which almost certainly means a sync broke.',
      notFound: 'Back to the latest',

      premiumTitle: 'Premium',
      premiumBlurb:
        'Following sections, notifications and calendar feeds stay free and always will. ' +
        'Premium is for the parts that cost us something to run.',
      premiumShare: 'Share your line with the people you choose, instead of the whole site.',
      premiumHistory:
        'Keep every message you have ever sent or received, not just the recent ones.',
      premiumInvites: 'Earn a share of what the people you bring in spend.',
    },
    // A story is a NewsArticle and a publisher is a NewsMediaOrganization. Both
    // are what an answer engine expects to find on a news page, and calling a
    // wire story a SportsEvent would be a lie told to every one of them.
    schema: {
      event: 'NewsArticle',
      participant: 'NewsMediaOrganization',
      collection: 'Thing',
    },
    sources: {
      lead: 'Stories from',
      list: [
        { name: 'the newsrooms’ own feeds', url: 'https://nichedb.dev/c/news' },
        { name: 'GDELT', url: 'https://www.gdeltproject.org' },
      ],
      note: 'Collected by nichedb.dev. Not affiliated with any publisher.',
    },
    providers: ['nichedb'],
    elsewhere: {
      sports: 'https://tipoffwatch.com',
      'film and tv': 'https://genrewatch.com',
    },
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

/**
 * Every site we run, for the footer of every one of them.
 *
 * Derived from BRANDS rather than written out again, because a brand entry IS a
 * site: a fourth one appears in all three footers the moment it exists, instead
 * of being remembered about later and half-linked. The list is deliberately the
 * SAME on every brand -- the view drops the site the reader is already on, so
 * this stays a description of the network rather than of one deployment.
 *
 * genrewatch.com still runs from its own repo, which does not change what it is
 * from a reader's side: one of ours, and worth a link from the others.
 */
export const network = Object.values(BRANDS).map(({ id, name, domain }) => ({
  id,
  name,
  domain,
  url: `https://${domain}`,
}));

/**
 * The house data platform, credited in the same footer line.
 *
 * Separate from the per-brand provider credit above it, which names the upstream
 * a given fixture actually came from and must stay accurate. This one names the
 * shop the data is furnished through.
 */
export const dataSource = { name: 'nichedb.dev', url: 'https://nichedb.dev' };
