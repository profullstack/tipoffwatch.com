import { brand, config, href, Word } from '@tipoff/config';

/**
 * The files written for machines rather than readers.
 *
 * robots.txt, llms.txt, skill.md and security.txt. They are built here, from the
 * brand and from the live catalogue counts, for the same reason every other
 * string in this repo is: a second site runs this code, and a hand-written file
 * in public/ would describe the wrong one.
 */

const url = (path) => `${config.siteUrl}${path}`;

/**
 * Paths no crawler should index, in one list.
 *
 * They are the same page for every signed-out visitor, they carry nothing a
 * search result should point at, and /api/ answers callers rather than readers.
 */
const DISALLOW = ['/login', '/signup', '/auth/', '/api/'];

/*
 * ...except the documented one.
 *
 * The footer has linked /api/v1 as "Public API" since it existed, and /about
 * calls it open and keyless -- while robots.txt forbade the whole of /api/. So
 * the one surface built for programs to read was the one surface programs were
 * told to stay out of, which three of the audit engines caught. Allow is longer
 * than the Disallow it sits under, and the longest match wins.
 */
const ALLOW = ['/api/v1'];

/**
 * Crawlers named explicitly, so their operators can see they are welcome.
 *
 * The trap this avoids: a crawler that finds a group matching its own name obeys
 * THAT group and ignores `User-agent: *` entirely. Naming GPTBot and then
 * listing the auth paths only under the wildcard would invite it straight into
 * /login -- which is the exact traffic that made robots.txt necessary here. So
 * every named group gets the same rules, generated rather than repeated.
 */
const NAMED = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'PerplexityBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bingbot',
];

const group = (agent) =>
  [
    `User-agent: ${agent}`,
    'Allow: /',
    ...ALLOW.map((p) => `Allow: ${p}`),
    ...DISALLOW.map((p) => `Disallow: ${p}`),
  ].join('\n');

/**
 * AwarioBot was 47% of all requests, fetching /login about once a second from a
 * single address. It was told to stop here, re-read this file, and carried on --
 * so app.js refuses it outright. This group stays because a crawler that later
 * starts behaving will read it and comply without anyone having to remember why.
 */
export const robotsTxt = () =>
  [
    'User-agent: AwarioBot',
    'Disallow: /',
    '',
    ...NAMED.map((a) => `${group(a)}\n`),
    group('*'),
    '',
    `Sitemap: ${url('/sitemap.xml')}`,
    '',
  ].join('\n');

/**
 * llms.txt -- the site in one file, for a model that has one request to spend.
 *
 * Link-rich and short on purpose: it is a map, not a copy of the site. The counts
 * come from the live catalogue rather than being typed in, because a number in a
 * static file is a number that is wrong by next week.
 */
export const llmsTxt = (stats = {}) => {
  const scale =
    stats.leagues && stats.teams
      ? `${stats.sports} ${brand.words.categories}, ${stats.leagues} ${brand.words.collections} ` +
        `and ${stats.teams} ${brand.words.participants}`
      : `every ${brand.words.collection} we cover`;

  return `# ${brand.name}

> ${brand.description} Reminders arrive an hour before the start and again a minute out, by web notification, email, or both -- and it works as a calendar subscription if you would rather not be notified at all.

${brand.name} covers ${scale}. Times are stored in UTC and shown in each reader's own time zone. Schedule data is fetched from upstream providers, normalised, and stored here, so the calendar goes stale rather than blank when an upstream is unavailable.

## Pages

- [Today](${url('/')}): every ${brand.words.event} on now or coming up today, with live scores.
- [Browse by ${brand.words.category}](${url(href.category())}): every ${brand.words.category} and ${brand.words.collection} in the catalogue.
- [About](${url('/about')}): what this is, where the data comes from, how reminders work, and what is free.
- [Premium](${url('/premium')}): the paid tier and what it costs. Following, reminders and calendar feeds are not part of it -- those are free.
- [Contact](${url('/contact')}): how to reach us.
- [Privacy](${url('/privacy')}): what is collected, why, and how to have it deleted.

## Data

- [Public API](${url('/api/v1')}): open JSON, no key and no account. Endpoints for ${brand.words.categories}, ${brand.words.collections} and ${brand.words.events}.
- [RSS and calendars](${url('/feeds')}): an RSS feed and an .ics subscription for every ${brand.words.category} and ${brand.words.collection}.
- [Everything feed](${url('/feeds/all.xml')}): the next 150 ${brand.words.events} across the whole catalogue.
- [Sitemap](${url('/sitemap.xml')}): a sitemap index covering static pages, ${brand.words.collections}, profiles, feeds, and ${brand.words.events} by month.

## Notes

- ${Word.event} pages carry schema.org markup: the start time, the venue and both sides are labelled rather than left to be inferred from prose.
- The API is the better surface for anything programmatic. It is bounded, cacheable, and does not change shape between deploys.
- Sign-in, sign-up and the API's non-documented paths are excluded in robots.txt. Everything else is open.
`;
};

/**
 * skill.md -- what an agent can actually do here, as opposed to read.
 *
 * Separate from llms.txt because they answer different questions: llms.txt is
 * "what is this site", this is "what can I call". Kept to the read paths, since
 * everything that writes needs a session.
 */
export const skillMd = () => `# ${brand.name}

${brand.description}

Free, open, and unauthenticated for reading. No key, no account, no rate card --
be reasonable and cache what you fetch.

Base URL: ${config.siteUrl}

## Tools

The paths are literal. They do not follow this brand's vocabulary -- the routes
are registered as \`sports\`, \`leagues\` and \`events\` on every site running this
code, and only what a reader is shown differs.

- \`GET /api/v1\` -- index. Returns the catalogue counts and the endpoint list.
- \`GET /api/v1/sports\` -- every ${brand.words.category}, with ${brand.words.collection} counts.
- \`GET /api/v1/leagues?sport=<slug>\` -- ${brand.words.collections}, optionally filtered.
- \`GET /api/v1/events?league=<slug>&sport=<slug>&limit=100\` -- upcoming ${brand.words.events}. Both filters optional; limit caps at 200.
- \`GET /api/v1/search?q=<term>\` -- ${brand.words.collections} and ${brand.words.participants} matching a term.
- \`GET /feeds/league/<slug>.xml\` -- the same ${brand.words.events} as RSS. Also \`/feeds/sport/<slug>.xml\` and \`/feeds/team/<slug>.xml\`.
- \`GET /calendar/league/<slug>.ics\` -- the same ${brand.words.events} as a calendar subscription.

## Answering "when does X play next"

Resolve the name with \`/api/v1/search\`, then read \`/api/v1/events\` for its slug. Every timestamp is UTC, ISO 8601. A ${brand.words.event} whose
\`time_known\` is false has a date and no announced start time -- present it as a
date rather than inventing an hour.

## What needs a person

Following, reminders, calendar tokens, messages and anything paid all require a
signed-in session. There is no API for them, deliberately: an agent should not be
able to sign a reader up for notifications.
`;

/**
 * RFC 9116. Contact is the only required field, and it may be a page rather than
 * an address -- which is what lets this exist before a mailbox does.
 */
export const securityTxt = () => {
  // A year out. The RFC requires the field and expects it to be kept current; a
  // date computed at boot means a redeploy renews it rather than it silently
  // ageing out of validity.
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  return [
    `Contact: ${url('/contact')}`,
    ...(config.contactEmail ? [`Contact: mailto:${config.contactEmail}`] : []),
    `Expires: ${expires}`,
    'Preferred-Languages: en',
    `Canonical: ${url('/.well-known/security.txt')}`,
    '',
  ].join('\n');
};
