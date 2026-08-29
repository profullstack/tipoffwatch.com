import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

/**
 * Handing a sport from one provider to another, which is a routing decision with
 * two halves that fail in different ways.
 *
 * ESPN and livetennis both know about the US Open. Left to themselves they both
 * write it, under two league rows, with two unrelated sets of players -- and a
 * follow then sees half its fixtures depending on which copy it landed on. So one
 * provider claims the sport and the other stands down.
 *
 * The half a migration can do is get out of the way once: free the slugs people
 * already have links to, and retire the incumbent. The half it cannot do is stay
 * out of the way, because `upsertLeague` sets `active = true` on conflict -- so the
 * next catalogue pass would undo the migration entirely if syncCatalogue did not
 * enforce the claim on every run. Both halves are asserted here.
 */
let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  // Seed the incumbent BETWEEN the migrations, not after them: a backfill asserted
  // against rows inserted afterwards passes vacuously, having migrated nothing.
  const handover = files.indexOf('0028_livetennis_claims_tennis.sql');
  expect(handover).toBeGreaterThan(0);

  for (const f of files.slice(0, handover)) await db.exec(await readFile(dir + f, 'utf8'));

  for (const [key, slug] of [
    ['tennis/atp', 'tennis-atp'],
    ['tennis/wta', 'tennis-wta'],
  ]) {
    await db.query(
      `insert into leagues (provider, provider_key, slug, name, sport, active, priority)
       values ('espn', $1, $2, $2, 'tennis', true, 3)`,
      [key, slug],
    );
  }
  // A control: another sport, untouched by any of this.
  await db.query(
    `insert into leagues (provider, provider_key, slug, name, sport, active, priority)
     values ('espn', 'football/nfl', 'football-nfl', 'nfl', 'football', true, 1)`,
  );

  for (const f of files.slice(handover)) await db.exec(await readFile(dir + f, 'utf8'));
});

describe('the migration', () => {
  test('frees the slugs people already have links to', async () => {
    // livetennis takes `tennis-atp` so the existing URL keeps working and starts
    // showing better data. leagues.slug is unique, so the incumbent has to move
    // first or the very first catalogue pass fails on the insert.
    const { rows } = await db.query(
      `select slug from leagues where provider = 'espn' and sport = 'tennis' order by slug`,
    );
    expect(rows.map((r) => r.slug)).toEqual(['espn-tennis-atp', 'espn-tennis-wta']);
  });

  test('retires the incumbent without deleting anything', async () => {
    // The rows carry finished fixtures and whatever anyone already follows.
    const { rows } = await db.query(
      `select active from leagues where provider = 'espn' and sport = 'tennis'`,
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.active === false)).toBe(true);
  });

  test('leaves every other sport alone', async () => {
    const { rows } = await db.query(`select slug, active from leagues where sport = 'football'`);
    expect(rows).toEqual([{ slug: 'football-nfl', active: true }]);
  });

  test('is safe to run twice', async () => {
    // Migrations run once, but a re-applied file must not turn espn-tennis-atp into
    // espn-espn-tennis-atp.
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    await db.exec(await readFile(`${dir}0028_livetennis_claims_tennis.sql`, 'utf8'));
    const { rows } = await db.query(
      `select slug from leagues where provider = 'espn' and sport = 'tennis' order by slug`,
    );
    expect(rows.map((r) => r.slug)).toEqual(['espn-tennis-atp', 'espn-tennis-wta']);
  });
});

describe('the claim', () => {
  test('tennis has exactly one owner when livetennis is enabled', async () => {
    const { config } = await import('../packages/config/src/index.js');
    const sports = await import('../packages/sports/src/index.js');

    const saved = config.sports.providers;
    try {
      config.sports.providers = ['espn', 'livetennis'];
      expect([...sports.sportClaims()]).toEqual([['tennis', 'livetennis']]);
    } finally {
      config.sports.providers = saved;
    }
  });

  test('turning the claim off is a config change, not a migration', async () => {
    // Nothing is claimed, so syncCatalogue deactivates nothing and upserts ESPN's
    // tennis straight back to active on the same pass. That is the property that
    // makes this reversible.
    const { config } = await import('../packages/config/src/index.js');
    const sports = await import('../packages/sports/src/index.js');

    const saved = config.sports.providers;
    try {
      config.sports.providers = ['espn'];
      expect([...sports.sportClaims()]).toEqual([]);
    } finally {
      config.sports.providers = saved;
    }
  });
});
