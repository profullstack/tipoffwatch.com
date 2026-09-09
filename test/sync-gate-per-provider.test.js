import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * Which adapter's clock the freshness gate reads.
 *
 * `syncBrandCatalog` skips an adapter whose last completed pass is newer than
 * its interval. That reading used to come from `lastSyncedAtForCategory` --
 * `max(rosters_synced_at) from leagues where sport = $1` -- which says nothing
 * about WHO wrote the row, while `ingest` stamps the clock on every collection
 * the adapter touched.
 *
 * That was correct for as long as every adapter owned its sections outright. The
 * moment two file under one desk it fails silently and completely: the one that
 * runs first stamps the desk, the second reads a clock it did not set, decides
 * it is fresh, and skips -- on that tick and on every tick after, logging
 * nothing worse than "fresh (2m old)". No error, no empty table, just a provider
 * that quietly stopped.
 *
 * Every adapter here owns its categories today, so nothing in this repository
 * exhibits it -- which is exactly why it is worth a test. The fork that reads
 * three news directories at once hit it immediately, and the fixtures below are
 * that shape: two providers, one shared desk.
 */
let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  // The same desk, written by both providers, which is the shape that broke.
  await db.query(
    `insert into leagues (provider, provider_key, slug, name, sport, active, rosters_synced_at)
     values
       ('nichedb', 'nichedb:beat:world', 'world-news', 'World', 'world', true, now()),
       ('brisk', 'brisk:desk:world', 'world-news-brisk', 'World', 'world', true,
        now() - interval '9 hours'),
       ('brisk', 'brisk:desk:independent', 'independent-news-brisk', 'Independent',
        'independent', true, now() - interval '9 hours')`,
  );
}, 60_000);

const byCategory = async (category) =>
  (
    await db.query(`select max(rosters_synced_at) as at from leagues where sport = $1 and active`, [
      category,
    ])
  ).rows[0].at;

const byProvider = async (provider) =>
  (
    await db.query(
      `select max(rosters_synced_at) as at from leagues where provider = $1 and active`,
      [provider],
    )
  ).rows[0].at;

const ageHours = (at) => (Date.now() - new Date(at).getTime()) / 3_600_000;

describe('the catalogue freshness gate', () => {
  test('asking by sport reports the OTHER provider pass as this one', async () => {
    // nichedb stamped 'world' a moment ago; brisk has not run for nine hours.
    expect(ageHours(await byCategory('world'))).toBeLessThan(1);
  });

  test('asking by provider reports the pass that adapter actually completed', async () => {
    expect(ageHours(await byProvider('brisk'))).toBeGreaterThan(8);
    expect(ageHours(await byProvider('nichedb'))).toBeLessThan(1);
  });

  /*
   * The regression itself, stated as the decision the gate makes. brisk's
   * interval is 180 minutes and it last ran nine hours ago, so it is due; the
   * category reading would have called it fresh and skipped it forever.
   */
  test('the second provider is due on its own clock and skipped on the shared one', async () => {
    const intervalMin = 180;
    const shared = (Date.now() - new Date(await byCategory('world')).getTime()) / 60_000;
    const own = (Date.now() - new Date(await byProvider('brisk')).getTime()) / 60_000;
    expect(shared < intervalMin).toBe(true); // would have skipped
    expect(own < intervalMin).toBe(false); // actually runs
  });

  test('an adapter that owns its desks outright reads the same either way', async () => {
    // Nothing but brisk writes 'independent', so both questions agree.
    expect(Math.round(ageHours(await byCategory('independent')))).toBe(
      Math.round(ageHours(await byProvider('brisk'))),
    );
  });

  test('the gate in syncBrandCatalog is the provider one', async () => {
    const src = await readFile(new URL('../packages/sports/src/index.js', import.meta.url), 'utf8');
    expect(src).toContain('lastSyncedAtForProvider(entry.name)');
    expect(src).not.toContain('lastSyncedAtForCategory(entry.category)');
  });
});
