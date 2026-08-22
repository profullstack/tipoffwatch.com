import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const rows = async (sql, p) => (await db.query(sql, p)).rows;

/**
 * The whole claim of the whitelabel, tested against a real Postgres.
 *
 * A genre is a collection, a show is a participant, an episode is an event with
 * one side. If this schema could not hold that, the sites would need different
 * databases and the shared codebase would be a fiction.
 */
describe('the sports schema holds a genre catalogue', () => {
  test('a genre is a league row whose sport is the category', async () => {
    const [g] = await rows(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('tvmaze','tvmaze:genre:drama','tv','drama-tv','Drama') returning id, sport`,
    );
    expect(g.sport).toBe('tv');
  });

  test('a show is a team row, and belongs to several genres at once', async () => {
    const [drama] = await rows(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('tvmaze','g1','tv','g1','Drama') returning id`,
    );
    const [scifi] = await rows(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('tvmaze','g2','tv','g2','Sci-Fi') returning id`,
    );
    const [show] = await rows(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('tvmaze','show:1',$1,'severance','Severance','Severance') returning id`,
      [drama.id],
    );
    await db.query(`insert into team_leagues (team_id, league_id) values ($1,$2), ($1,$3)`, [
      show.id,
      drama.id,
      scifi.id,
    ]);
    const [n] = await rows(`select count(*)::int as n from team_leagues where team_id=$1`, [
      show.id,
    ]);
    // The many-to-many this needed already existed, for clubs in a domestic league
    // and a cup at the same time.
    expect(n.n).toBe(2);
  });

  test('an episode is an event with ONE side, which the schema already allowed', async () => {
    const [g] = await rows(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('tvmaze','g3','tv','g3','Drama') returning id`,
    );
    const [show] = await rows(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('tvmaze','show:2',$1,'s2','S','S') returning id`,
      [g.id],
    );
    const [e] = await rows(
      `insert into events (provider, provider_key, league_id, starts_at, name,
                          home_team_id, away_team_id, time_known, precision)
       values ('tvmaze','ep:1',$1, now() + interval '1 day', 'S 1x01', $2, null, true, 'minute')
       returning id, home_team_id, away_team_id`,
      [g.id, show.id],
    );
    // Nullable since 0001, because a race and a fight card have no two sides.
    expect(e.home_team_id).toBe(show.id);
    expect(e.away_team_id).toBeNull();
  });

  test('a film release is the same row with no clock time', async () => {
    const [g] = await rows(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('tmdb','g4','film','g4','Drama') returning id`,
    );
    const [film] = await rows(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('tmdb','movie:1',$1,'dune','Dune','Dune') returning id`,
      [g.id],
    );
    const [e] = await rows(
      `insert into events (provider, provider_key, league_id, starts_at, name,
                          home_team_id, time_known, precision)
       values ('tmdb','rel:1',$1,'2026-12-16T12:00:00Z','Dune',$2,false,'day')
       returning time_known, precision, starts_at`,
      [g.id, film.id],
    );
    expect(e.time_known).toBe(false);
    expect(e.precision).toBe('day');
    // Noon UTC, never midnight: midnight is the previous evening for the Americas,
    // so a day-before reminder would fire two days early.
    expect(new Date(e.starts_at).toISOString()).toContain('T12:00');
  });

  test('sport and genre rows coexist without colliding', async () => {
    await db.query(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','eng.1','soccer','soccer-eng-1','Premier League')`,
    );
    const [n] = await rows(`select count(distinct sport)::int as n from leagues`);
    expect(n.n).toBeGreaterThanOrEqual(3);
  });
});

describe('a brand runs only its own providers', () => {
  test('the genre brand does not walk ESPN', async () => {
    const src = await readFile(
      new URL('../packages/queue/src/workers.js', import.meta.url).pathname,
      'utf8',
    );
    // 354 leagues at two requests each is ~700 upstream calls spent populating a
    // section the genre site does not even route to.
    expect(src).toContain("brand.providers.includes('espn')");
    expect(src).toContain('syncBrandCatalog');
  });

  test('every adapter in the registry is claimed by some brand', async () => {
    const { CATALOG_ADAPTERS } = await import('../packages/sports/src/catalog.js');
    const { brands } = await import('../packages/config/src/brands.js');
    const claimed = new Set(Object.values(brands).flatMap((b) => b.providers));
    for (const a of CATALOG_ADAPTERS) expect(claimed.has(a.name)).toBe(true);
  });

  test('spaceflight runs before music, because it has one chance an hour', async () => {
    const { CATALOG_ADAPTERS } = await import('../packages/sports/src/catalog.js');
    const names = CATALOG_ADAPTERS.map((a) => a.name);
    expect(names.indexOf('spacedevs')).toBeLessThan(names.indexOf('musicbrainz'));
  });
});
