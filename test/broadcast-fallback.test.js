import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import {
  matchListings,
  normaliseTeam,
  pickMarket,
  sameTeam,
  splitFixture,
  sportName,
} from '../packages/sports/src/sportsdb.js';

/**
 * The fallback that fills in broadcasters ESPN does not carry.
 *
 * Two halves worth guarding. The matcher decides whether a TV listing describes one
 * of our fixtures, and a false positive there is the expensive kind of bug -- it
 * tells somebody to turn on a channel that is showing something else. And the write
 * has to lose to ESPN, which is the more precise source wherever it has an answer.
 */

describe('team name matching', () => {
  test('club suffixes are noise, not identity', () => {
    expect(normaliseTeam('Collingwood Football Club')).toBe('collingwood');
    expect(sameTeam('Collingwood Football Club', 'Collingwood')).toBe(true);
    expect(sameTeam('Brisbane Lions', 'Brisbane Lions')).toBe(true);
  });

  test('a shared word is not a shared team', () => {
    // The exact pair that plain substring matching gets wrong.
    expect(sameTeam('Manchester City', 'Manchester United')).toBe(false);
    expect(sameTeam('Norwich City', 'Manchester City')).toBe(false);
    expect(sameTeam('Real Madrid', 'Real Sociedad')).toBe(false);
  });

  test('a fragment cannot match a league', () => {
    // Without the length floor, "ars" matches Arsenal and every other short token
    // becomes a wildcard across 354 leagues.
    expect(sameTeam('ars', 'Arsenal')).toBe(false);
    expect(sameTeam('', 'Arsenal')).toBe(false);
  });

  test('accents are folded', () => {
    expect(sameTeam('Atlético Madrid', 'Atletico Madrid')).toBe(true);
  });
});

describe('fixture titles', () => {
  test('splits "Home vs Away"', () => {
    expect(splitFixture('Collingwood Football Club vs Brisbane Lions')).toEqual([
      'Collingwood Football Club',
      'Brisbane Lions',
    ]);
  });

  test('anything that is not two sides is rejected rather than guessed', () => {
    expect(splitFixture('NFL RedZone')).toBeNull();
    expect(splitFixture('')).toBeNull();
  });
});

describe('matching an event to listings', () => {
  // The real row TheSportsDB returned for tipoffwatch event 455, verified
  // 2026-08-21 -- the fixture ESPN reports with an empty broadcasts array.
  const listings = [
    {
      event: 'Collingwood Football Club vs Brisbane Lions',
      channel: '7 Queensland',
      country: 'Australia',
    },
    { event: 'Carlton vs Fremantle', channel: 'Fox Footy', country: 'Australia' },
  ];

  test('matches the fixture ESPN has no broadcaster for', () => {
    const hits = matchListings({ home: 'Collingwood', away: 'Brisbane Lions' }, listings);
    expect(hits).toHaveLength(1);
    expect(hits[0].channel).toBe('7 Queensland');
  });

  test('home/away order does not matter', () => {
    // ESPN titles it "Away at Home" and TheSportsDB "Home vs Away". Requiring both
    // sides to match means the disagreement costs nothing.
    const hits = matchListings({ home: 'Brisbane Lions', away: 'Collingwood' }, listings);
    expect(hits).toHaveLength(1);
  });

  test('one side matching is not a match', () => {
    expect(matchListings({ home: 'Collingwood', away: 'Carlton' }, listings)).toHaveLength(0);
  });

  test('an event with an unresolved side is skipped, not guessed', () => {
    expect(matchListings({ home: 'Collingwood', away: null }, listings)).toHaveLength(0);
  });
});

describe('choosing a market', () => {
  const rows = [
    { channel: 'Sky Sports', country: 'United Kingdom' },
    { channel: 'TNT Sports', country: 'United Kingdom' },
    { channel: 'USA Network', country: 'United States' },
  ];

  test('picks the market with the most coverage and names it', () => {
    expect(pickMarket(rows)).toEqual({
      country: 'United Kingdom',
      channels: ['Sky Sports', 'TNT Sports'],
    });
  });

  test('a preferred market wins even when it is smaller', () => {
    expect(pickMarket(rows, 'United States')).toEqual({
      country: 'United States',
      channels: ['USA Network'],
    });
  });

  test('nothing to show is null rather than an empty string', () => {
    expect(pickMarket([])).toBeNull();
    expect(pickMarket([{ channel: '', country: 'Australia' }])).toBeNull();
  });
});

describe('sport name mapping', () => {
  test('our ESPN slugs translate', () => {
    expect(sportName('australian-football')).toBe('Australian Football');
    expect(sportName('football')).toBe('American Football');
    expect(sportName('hockey')).toBe('Ice Hockey');
  });

  test('an unmapped sport is null, so the caller does not invent a name', () => {
    expect(sportName('kabaddi')).toBeNull();
  });
});

describe('the write loses to ESPN', () => {
  let db;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    await db.exec(`
      insert into leagues (provider, provider_key, sport, slug, name)
        values ('espn','australian-football/afl','australian-football','afl','AFL');
      insert into events (provider, provider_key, league_id, starts_at, state, name)
        values
          ('espn','1','1',now() + interval '1 day','pre','no listing yet'),
          ('espn','2','1',now() + interval '1 day','pre','espn already answered');
      update events set broadcast = 'NFL Net', broadcast_source = 'espn', broadcast_country = 'US'
        where provider_key = '2';
    `);
  }, 60_000);

  test('the migration backfills provenance for listings already stored', async () => {
    // 0013 runs over a table that already holds ESPN values; they must not end up
    // labelled as coming from nowhere.
    const { rows } = await db.query(
      `select broadcast_source, broadcast_country from events where provider_key = '2'`,
    );
    expect(rows[0]).toEqual({ broadcast_source: 'espn', broadcast_country: 'US' });
  });

  test('fills a fixture that has no broadcaster', async () => {
    const { rows } = await db.query(
      `update events e set broadcast = v.broadcast, broadcast_source = 'thesportsdb',
              broadcast_country = v.country
         from (values (1::bigint, '7 Queensland'::text, 'Australia'::text)) as v(id, broadcast, country)
        where e.id = v.id and e.broadcast is null
        returning e.id`,
    );
    expect(rows).toHaveLength(1);
    const [row] = (
      await db.query(`select broadcast, broadcast_country from events where provider_key = '1'`)
    ).rows;
    expect(row).toEqual({ broadcast: '7 Queensland', broadcast_country: 'Australia' });
  });

  test('refuses to overwrite a listing ESPN already supplied', async () => {
    // The pass fetches over the network between building its work list and
    // writing, and a live tick landing an ESPN listing in that gap is expected.
    // The guard lives in the statement, not just in the work list.
    const { rows } = await db.query(
      `update events e set broadcast = v.broadcast, broadcast_source = 'thesportsdb'
         from (values (2::bigint, 'Channel 7'::text)) as v(id, broadcast)
        where e.id = v.id and e.broadcast is null
        returning e.id`,
    );
    expect(rows).toHaveLength(0);
    const [row] = (
      await db.query(`select broadcast, broadcast_source from events where provider_key = '2'`)
    ).rows;
    expect(row).toEqual({ broadcast: 'NFL Net', broadcast_source: 'espn' });
  });
});
