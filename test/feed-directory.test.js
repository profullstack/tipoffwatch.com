import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * Everything the feed directory links must answer.
 *
 * /feeds and /sitemaps/feeds.xml both list one feed per sport in the catalogue, and
 * the feed route used to decide 404 on the fixtures instead of the catalogue: no
 * upcoming events, therefore not found. Most of 354 leagues are out of season most
 * of the year, so that shipped dead links on a page whose whole purpose is to be
 * crawled -- on 2026-08-30 the live site listed 16 sports and served 404 for hockey,
 * lacrosse and water polo.
 *
 * The rule now is the one /calendar/league already used: an unknown name is a 404, a
 * real name with nothing scheduled is an empty channel. So the set the directory
 * lists and the set the route answers have to be the same set, which is what this
 * pins.
 */
let db;

/** The predicate behind listSports() -- what /feeds and the sitemap link. */
const directorySports = async () => {
  const { rows } = await db.query(
    `select sport from leagues where active and superseded_by is null group by sport order by sport`,
  );
  return rows.map((r) => r.sport);
};

/** The predicate behind sportExists() -- what the feed route resolves a name against. */
const routeResolves = async (sport) => {
  const { rows } = await db.query(
    `select 1 from leagues where active and superseded_by is null and sport = $1 limit 1`,
    [sport],
  );
  return rows.length > 0;
};

/** The predicate behind feedEvents({ sport }) -- what fills the channel. */
const feedItems = async (sport) => {
  const { rows } = await db.query(
    `select e.id
       from events e join leagues l on l.id = e.league_id
      where e.starts_at > now() - interval '3 hours' and l.sport = $1`,
    [sport],
  );
  return rows.length;
};

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const league = async (slug, sport, active = true) => {
    const { rows } = await db.query(
      `insert into leagues (provider, provider_key, slug, name, sport, active, priority)
       values ('espn', $1, $2, $2, $3, $4, 1) returning id`,
      [`${sport}/${slug}`, slug, sport, active],
    );
    return rows[0].id;
  };
  const event = (leagueId, offset, name) =>
    db.query(
      `insert into events (provider, provider_key, league_id, starts_at, state, name)
       values ('espn', $1, $2, now() + $3::interval, 'pre', $4)`,
      [`espn/${name}`, leagueId, offset, name],
    );

  // In season.
  await event(await league('mlb', 'baseball'), '6 hours', 'in-season');
  // Real, listed, and between seasons -- the case that used to 404.
  await event(await league('nhl', 'hockey'), '-40 days', 'last-season');
  // Real and listed, and no fixture has ever been written for it.
  await league('ncaa-water-polo', 'water-polo');
  // Not listed, so not resolvable either, fixture or no fixture.
  await event(await league('bbl', 'cricket', false), '6 hours', 'inactive-league');
}, 60_000);

describe('the sports the directory links', () => {
  test('a sport is listed on its catalogue, not on having a game scheduled', async () => {
    expect(await directorySports()).toEqual(['baseball', 'hockey', 'water-polo']);
  });

  test('every listed sport resolves, so no link on /feeds or the sitemap is dead', async () => {
    for (const sport of await directorySports()) {
      expect([sport, await routeResolves(sport)]).toEqual([sport, true]);
    }
  });

  test('an out-of-season sport resolves with an empty channel, not a 404', async () => {
    // Both halves matter: the name is real, and there is genuinely nothing to list.
    // The old route saw only the second half and called it not found.
    expect(await routeResolves('hockey')).toBe(true);
    expect(await feedItems('hockey')).toBe(0);

    expect(await routeResolves('water-polo')).toBe(true);
    expect(await feedItems('water-polo')).toBe(0);

    expect(await feedItems('baseball')).toBe(1);
  });

  test('a name nobody publishes under is still a 404', async () => {
    // The reason the route resolves a name at all: this must not become a valid
    // empty feed for any string somebody types.
    expect(await routeResolves('quidditch')).toBe(false);
    // An inactive league does not put its sport in the directory, so it must not
    // answer either -- even though it has a fixture tonight.
    expect(await directorySports()).not.toContain('cricket');
    expect(await routeResolves('cricket')).toBe(false);
  });
});

describe('the feed route decides on the subject, not the fixtures', () => {
  test('it resolves a name first and never 404s an empty result', async () => {
    const src = await Bun.file(new URL('../apps/web/src/app.js', import.meta.url).pathname).text();

    // The regression this replaced, in its exact original form.
    expect(src).not.toContain('if (events.length === 0) return c.notFound();');

    const route = src.slice(src.indexOf("app.get('/feeds/:scope/:file'"));
    const handler = route.slice(0, route.indexOf('\n});'));
    expect(handler).toContain('const label = await feedSubjectName(scope, key);');
    expect(handler).toContain('if (!label) return c.notFound();');
    // Resolved before the fixtures are read, or the empty case never reaches it.
    expect(handler.indexOf('feedSubjectName')).toBeLessThan(handler.indexOf('q.feedEvents'));
  });
});
