/**
 * News, from nichedb.dev.
 *
 * Unlike every other adapter here, the upstream is ours: nichedb's `news`
 * collection already does the fetching, parsing and deduplication against
 * newsroom RSS and GDELT, and exposes the result as keyless JSON. So this
 * adapter is a projection, not a scraper — which is the point of having built
 * the collection there rather than a seventh set of feed parsers here.
 *
 * How news lands in a schema built for fixtures:
 *
 * - a **beat** becomes a league row. GDELT items carry their beat directly
 *   (`data.query`); newsroom items come from world desks, so their beat is
 *   `world` — that is a description of those seven feeds, not a catch-all.
 * - an **outlet** becomes a team row. For newsroom items that is the publisher
 *   (`data.outlet`); for GDELT it is the source domain, which is why this brand
 *   has hundreds of followable outlets rather than seven.
 * - a **story** becomes an event with one side, the way a race already is.
 *
 * The one thing the shared schema cannot express is tense. A fixture is
 * something that will happen; a story has already been published. Stories are
 * therefore ingested as `out`, which `stateOf` stores as `post`, and they reach
 * a reader through the home page (which asks for today, not for upcoming) and
 * the results page. Nothing here is ever `pre`, so this brand's "starting soon"
 * page is empty by construction rather than by accident, and its copy says so.
 */

import { getJson } from './http.js';
import { keyFor, slugify } from './slug.js';

const BASE = 'https://nichedb.dev/api/v1';
const PROVIDER = 'nichedb';
export const CATEGORY = 'news';

/** nichedb caps a page at 200 however much you ask for. */
const PAGE = 200;

/** Publisher slugs are delivery-host derived, so give the known ones real names. */
export const OUTLET_NAMES = {
  bbci: 'BBC News',
  aljazeera: 'Al Jazeera',
  theguardian: 'The Guardian',
  dw: 'Deutsche Welle',
  france24: 'France 24',
  npr: 'NPR',
  dj: 'The Wall Street Journal',
};

/** Beats worth putting in front of a reader first. */
const BEAT_PRIORITY = { world: 10, economy: 20, election: 20, conflict: 20 };

const titleCase = (s) =>
  String(s ?? '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/**
 * The beat a story belongs to.
 *
 * GDELT states it. A newsroom feed does not, but every default feed in the
 * nichedb source is a world desk, so `world` is the honest answer rather than an
 * "Uncategorised" bucket nobody would choose to browse.
 */
export function beatOf(item) {
  const q = item?.data?.query;
  if (typeof q === 'string' && q.trim()) return q.trim().toLowerCase();
  return item?.adapter === 'newsfeed' ? 'world' : null;
}

/**
 * The outlet that published a story, as {key, name}.
 *
 * A GDELT row names a domain and nothing friendlier, so the domain is the name.
 * Stripping `www.` matters: the same publisher arrives both ways and would
 * otherwise become two outlets a reader has to follow separately.
 */
export function outletOf(item) {
  const d = item?.data ?? {};
  if (typeof d.outlet === 'string' && d.outlet.trim()) {
    const slug = d.outlet.trim().toLowerCase();
    return { key: slug, name: OUTLET_NAMES[slug] ?? titleCase(slug) };
  }
  if (typeof d.domain === 'string' && d.domain.trim()) {
    const host = d.domain
      .trim()
      .toLowerCase()
      .replace(/^www\./, '');
    return { key: host, name: host };
  }
  return null;
}

/**
 * The URL an outlet lives at.
 *
 * `slugify(name, key)` would be unique on its own, but it keeps only the LAST
 * EIGHT characters of the discriminator, which turns Al Jazeera into
 * `al-jazeera-ljazeera` — a URL that reads like a bug. Publisher names and
 * domains are already distinct within their own group, so the plain slug is
 * used, and the discriminated form is kept as the fallback for the one case
 * that could genuinely collide: a domain under a word TLD, `bbc.news` against
 * the outlet named BBC News. `teams.slug` is UNIQUE, so a clash would abort the
 * whole upsert batch rather than merely look wrong.
 */
export function outletSlug(outlet, outletKey, outlets) {
  const plain = slugify(outlet.name);
  for (const row of outlets.values()) {
    if (row.slug === plain && row.providerKey !== outletKey) {
      return slugify(outlet.name, outlet.key);
    }
  }
  return plain;
}

/** Fetch one keyset page of a kind. */
async function page(kind, before) {
  const url =
    `${BASE}/items?collection=news&kind=${encodeURIComponent(kind)}&limit=${PAGE}` +
    (before ? `&before=${encodeURIComponent(before)}` : '');
  const res = await getJson(url, { timeoutMs: 30_000 });
  return res?.items ?? [];
}

/**
 * Turn a page of nichedb items into catalogue rows, accumulating into the maps.
 *
 * Exported so the mapping can be tested without the network, which is the only
 * part of this adapter with any decisions in it.
 */
export function collect(items, { beats, outlets, events }) {
  for (const it of items ?? []) {
    if (!it?.id || !it.title) continue;
    const publishedAt = it.published_at ? new Date(it.published_at) : null;
    // A story with no timestamp cannot be placed on a day, and the home page is
    // a day. Skipped rather than dated to "now", which would make every backfill
    // look like breaking news.
    if (!publishedAt || Number.isNaN(publishedAt.getTime())) continue;

    const beat = beatOf(it);
    const outlet = outletOf(it);
    if (!beat || !outlet) continue;

    const beatKey = keyFor(PROVIDER, 'beat', beat);
    if (!beats.has(beatKey)) {
      beats.set(beatKey, {
        provider: PROVIDER,
        providerKey: beatKey,
        category: CATEGORY,
        slug: slugify(`${beat}-news`),
        name: titleCase(beat),
        priority: BEAT_PRIORITY[beat] ?? 100,
      });
    }

    const outletKey = keyFor(PROVIDER, 'outlet', outlet.key);
    if (!outlets.has(outletKey)) {
      outlets.set(outletKey, {
        provider: PROVIDER,
        providerKey: outletKey,
        category: CATEGORY,
        kind: 'outlet',
        slug: outletSlug(outlet, outletKey, outlets),
        name: outlet.name,
        displayName: outlet.name,
        description: null,
        imageUrl: null,
        url: null,
        genreKeys: [],
      });
    }
    // An outlet publishes across beats, so its set accumulates.
    const row = outlets.get(outletKey);
    if (!row.genreKeys.includes(beatKey)) row.genreKeys.push(beatKey);

    events.push({
      provider: PROVIDER,
      providerKey: keyFor(PROVIDER, 'story', String(it.id)),
      category: CATEGORY,
      subjectKey: outletKey,
      kind: 'story',
      startsAt: publishedAt,
      // Wire copy carries a real timestamp; nothing here is a date-only guess.
      timeKnown: it.time_known !== false,
      precision: it.precision ?? 'minute',
      // Published, not scheduled. See the note at the top of this file.
      state: 'out',
      name: it.title,
      shortName: null,
      summary: it.summary ?? null,
      imageUrl: it.image_url ?? null,
      url: it.url ?? null,
      venue: null,
      venueRegion: it.data?.country ?? null,
      season: null,
      number: null,
      runtimeMin: null,
    });
  }
}

/**
 * Recent stories, newest first.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxPages] 200 items each. nichedb is ours and answers in
 *   milliseconds, so the ceiling here is how much history is worth carrying, not
 *   a rate limit.
 */
export async function fetchAll({ maxPages = 5 } = {}) {
  const beats = new Map();
  const outlets = new Map();
  const events = [];

  let before;
  for (let i = 0; i < maxPages; i++) {
    const items = await page('story', before);
    if (items.length === 0) break;
    collect(items, { beats, outlets, events });
    before = items[items.length - 1]?.id;
    if (!before || items.length < PAGE) break;
  }

  return { genres: [...beats.values()], subjects: [...outlets.values()], events };
}

export const adapter = { name: PROVIDER, category: CATEGORY, fetchAll };
