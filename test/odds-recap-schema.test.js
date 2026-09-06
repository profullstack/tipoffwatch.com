import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * The line survives kickoff, and the box score queue drains.
 *
 * Both are properties of the SQL rather than of the parsing that
 * odds-and-recap.test.js covers, so they run against a real Postgres in-process --
 * same harness as schema.test.js, its own database so the two cannot interfere.
 *
 * The first property is the one the whole feature rests on. ESPN publishes a line
 * only while a fixture is unplayed and returns nothing in its place afterwards, so
 * every sync from kickoff onward carries a null. An assignment rather than a
 * coalesce would therefore erase the line on the very pass that makes it worth
 * having, and would do it silently -- the column would simply be empty on exactly
 * the pages built to show it.
 */
let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  // A WASM Postgres boot plus every migration overruns bun's 5s default on a loaded
  // machine. The work is legitimately slow rather than hung.
}, 60_000);

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const LINE = JSON.stringify({ details: 'SEA -3.5', spread: -3.5, favorite: 'home' });

describe('the captured line', () => {
  let league;
  beforeAll(async () => {
    league = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','football/nflq','football','football-nflq','NFL Q') returning id`,
    );
  });

  /** upsertEvents, reduced to the clause under test. */
  const upsert = (key, odds) =>
    db.query(
      `insert into events (provider, provider_key, league_id, starts_at, name, state, odds)
       values ('espn',$1,$2, now(), 'G', 'pre', $3::jsonb)
       on conflict (provider, provider_key) do update set
         state = excluded.state,
         odds = coalesce(excluded.odds, events.odds)`,
      [key, league.id, odds],
    );

  test('a line captured before kickoff is not wiped by the syncs after it', async () => {
    await upsert('football/nflq/1', LINE);
    // Every pass from kickoff onward looks exactly like these two: same fixture,
    // no odds, because the book has stopped pricing it.
    await upsert('football/nflq/1', null);
    await upsert('football/nflq/1', null);
    const row = await one(`select odds from events where provider_key = 'football/nflq/1'`);
    expect(row.odds.details).toBe('SEA -3.5');
  });

  test('a newer line still replaces an older one while the book is still pricing it', async () => {
    await upsert('football/nflq/2', LINE);
    await upsert('football/nflq/2', JSON.stringify({ details: 'SEA -6.5', spread: -6.5 }));
    const row = await one(`select odds from events where provider_key = 'football/nflq/2'`);
    expect(row.odds.details).toBe('SEA -6.5');
  });

  test('the score tick coalesces the same way the sweep does', async () => {
    await upsert('football/nflq/3', LINE);
    // updateEventScores, reduced to the clause under test. This is the pass that
    // matters most: it runs every minute over the leagues with something on, so it
    // is both the last writer to see a line and the first to see it gone.
    await db.query(
      `update events e set state = v.state, odds = coalesce(v.odds::jsonb, e.odds)
       from (select $1::text as state, $2::text as odds) v
       where e.provider_key = 'football/nflq/3'`,
      ['in', null],
    );
    const row = await one(`select odds, state from events where provider_key = 'football/nflq/3'`);
    expect(row.state).toBe('in');
    expect(row.odds.details).toBe('SEA -3.5');
  });
});

/**
 * Which finished games are owed a box score.
 *
 * Deliberately NOT gated on plays_supported. Six sports return a box score and no
 * play log at all, so that gate would deny a recap to precisely the sports where
 * the box score is the only thing the provider has.
 */
describe('the recap queue', () => {
  const RECAP_DUE = `
    select e.id from events e
    join leagues l on l.id = e.league_id
    where e.state = 'post'
      and l.boxscore_supported
      and e.recap_synced_at is null
      and e.starts_at > now() - ($1 * interval '1 hour')
    order by e.starts_at desc`;

  const due = async (hours = 12) => (await db.query(RECAP_DUE, [hours])).rows.map((r) => r.id);

  let league;
  beforeAll(async () => {
    league = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','football/nflr','football','football-nflr','NFL R') returning id`,
    );
  });

  const mkEvent = (leagueId, key, hoursAgo, state = 'post') =>
    one(
      `insert into events (provider, provider_key, league_id, starts_at, name, state)
       values ('espn',$1,$2, now() - ($3 * interval '1 hour'),'G',$4) returning id`,
      [key, leagueId, hoursAgo, state],
    );

  test('a finished game with no box score yet is due, and stops being due once read', async () => {
    const ev = await mkEvent(league.id, 'football/nflr/1', 2);
    expect(await due()).toContain(ev.id);

    /*
     * Closed out by the STAMP, not by the recap being non-null. A fixture whose
     * summary genuinely carries no box score has to stop being asked about, or it
     * sits at the front of this queue forever burning a 500KB read per pass --
     * which is the exact churn plays_final was introduced to stop.
     */
    await db.query(`update events set recap = null, recap_synced_at = now() where id = $1`, [
      ev.id,
    ]);
    expect(await due()).not.toContain(ev.id);
  });

  test('a game still being played is not owed a box score yet', async () => {
    const ev = await mkEvent(league.id, 'football/nflr/2', 1, 'in');
    expect(await due()).not.toContain(ev.id);
  });

  test('the catch-up window bounds how far back the queue reaches', async () => {
    const old = await mkEvent(league.id, 'football/nflr/3', 40);
    expect(await due(12)).not.toContain(old.id);
    expect(await due(168)).toContain(old.id);
  });

  test('a sport with a box score but no play log is still offered a recap', async () => {
    const vb = await one(
      `insert into leagues (provider, provider_key, sport, slug, name, plays_supported)
       values ('espn','volleyball/x','volleyball','volleyball-x','VB', false) returning id`,
    );
    const ev = await mkEvent(vb.id, 'volleyball/x/1', 1);
    expect(await due()).toContain(ev.id);
  });

  test('sports whose summary endpoint has nothing are excluded by flag, not by guesswork', async () => {
    const { rows } = await db.query(
      `select sport, bool_and(boxscore_supported) as on from leagues
       where sport = any($1::text[]) group by sport`,
      [['tennis', 'golf', 'racing', 'mma']],
    );
    // Only asserts about sports the catalogue actually holds; an empty result here
    // would mean the seed has no such league, not that the flag is wrong.
    for (const r of rows) {
      expect({ sport: r.sport, on: r.on }).toEqual({ sport: r.sport, on: false });
    }
  });
});

describe('results browsing', () => {
  let league;
  beforeAll(async () => {
    league = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','football/nfls','football','football-nfls','NFL S') returning id`,
    );
    for (const [key, hoursAgo, state] of [
      ['football/nfls/1', 1, 'post'],
      ['football/nfls/2', 25, 'post'],
      ['football/nfls/3', 24 * 30, 'post'],
      ['football/nfls/4', 1, 'in'],
    ]) {
      await db.query(
        `insert into events (provider, provider_key, league_id, starts_at, name, state)
         values ('espn',$1,$2, now() - ($3 * interval '1 hour'),'G',$4)`,
        [key, league.id, hoursAgo, state],
      );
    }
  });

  const results = async (days) =>
    (
      await db.query(
        `select e.provider_key from events e
         join leagues l on l.id = e.league_id and l.superseded_by is null
         where e.state = 'post'
           and e.starts_at > now() - ($1 * interval '1 day')
           and e.league_id = $2
         order by e.starts_at desc`,
        [days, league.id],
      )
    ).rows.map((r) => r.provider_key);

  test('newest first, finished only, and inside the window', async () => {
    expect(await results(7)).toEqual(['football/nfls/1', 'football/nfls/2']);
  });

  /*
   * A floor rather than a filter. Without it a league dormant since 2019 sorts its
   * last-ever fixture into "recent results" and looks like it played last night.
   */
  test('the window is what keeps a results page from becoming an archive', async () => {
    expect(await results(365)).toHaveLength(3);
  });
});

/**
 * Filling in the line for games that were already over when this shipped.
 *
 * Odds are captured before kickoff, so every future fixture has them. Nothing can
 * reach back for the ones already played -- the scoreboard has dropped the field --
 * except the recap pass, whose summary still carries pickcenter.
 */
describe('the backfilled closing line', () => {
  let backfillLeague;
  beforeAll(async () => {
    backfillLeague = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','football/nflt','football','football-nflt','NFL T') returning id`,
    );
  });

  /** saveRecap, reduced to the clause under test. */
  const saveRecap = (key, odds) =>
    db.query(
      `update events set recap = '{}'::jsonb, recap_synced_at = now(),
              odds = coalesce(events.odds, $2::jsonb)
        where provider_key = $1`,
      [key, odds],
    );

  const mk = (key, odds) =>
    db.query(
      `insert into events (provider, provider_key, league_id, starts_at, name, state, odds)
       values ('espn',$1,$2, now() - interval '2 hours','G','post',$3::jsonb)`,
      [key, backfillLeague.id, odds],
    );

  test('a finished game with no stored line gets one from its own recap', async () => {
    await mk('football/nflt/1', null);
    await saveRecap('football/nflt/1', JSON.stringify({ details: 'USC -37.5' }));
    const row = await one(`select odds from events where provider_key = 'football/nflt/1'`);
    expect(row.odds.details).toBe('USC -37.5');
  });

  /*
   * The pre-kickoff capture is the better number -- the live tick took it within a
   * minute of the game starting, whereas pickcenter afterwards is a book quoting a
   * settled market. So the backfill fills gaps and never overwrites.
   */
  test('a line captured before kickoff is not replaced by the settled one', async () => {
    await mk('football/nflt/2', JSON.stringify({ details: 'USC -37.5', capturedState: 'pre' }));
    await saveRecap('football/nflt/2', JSON.stringify({ details: 'USC -100000' }));
    const row = await one(`select odds from events where provider_key = 'football/nflt/2'`);
    expect(row.odds.details).toBe('USC -37.5');
    expect(row.odds.capturedState).toBe('pre');
  });
});

describe('the queries still say what these tests assert', () => {
  test('the predicates and both coalesces are the ones in queries.js', async () => {
    const src = await Bun.file(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    ).text();
    const normalise = (s) =>
      s
        .replace(/\$\d+|\$\{[^}]+\}/g, '?')
        .replace(/\s+/g, ' ')
        .trim();
    const has = (clause) => expect(normalise(src)).toContain(normalise(clause));

    has('l.boxscore_supported');
    has('e.recap_synced_at is null');
    // Both writers must coalesce, or the line is erased at kickoff. These two are
    // the entire correctness argument for storing odds at all.
    has('odds = coalesce(excluded.odds, events.odds)');
    has('odds = coalesce(v.odds::jsonb, e.odds)');
    // And the backfill fills a gap rather than overwriting a better reading.
    has('odds = coalesce(events.odds, ?::jsonb)');
    // The list query must not haul a box score per row to render rows that never
    // show one; e.* here would read sixty of them for a page of sixty results.
    // Bounded to this one function -- every other list query legitimately uses e.*,
    // so a slice running to end of file finds one of theirs and fails for a reason
    // that has nothing to do with what is being asserted.
    const from = src.indexOf('export async function recentResults');
    expect(from).toBeGreaterThan(-1);
    const body = src.slice(from, src.indexOf('export async function', from + 1));
    expect(body).not.toMatch(/^\s*select e\.\*/m);
    expect(body).toContain('select e.id, e.starts_at');
  });
});
