import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * The line over time.
 *
 * `events.odds` holds one reading and every sync overwrites it, so the movement is
 * destroyed as fast as it is captured. The provider sells no history and cannot be
 * asked for one, so this series exists only if we write it down as we go -- and a
 * reading not taken today can never be recovered.
 *
 * The whole design rests on the dedupe. The score tick runs every minute over the
 * leagues with a game on, so without it this table would take a row per fixture
 * per minute and be almost entirely identical rows.
 */
let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

/*
 * recordOddsSnapshots, reduced to the statement under test. Kept in step with the
 * real one by the guard at the bottom of this file.
 */
const RECORD = `
  with candidate as (
    select e.id as event_id,
           e.state as captured_state,
           e.odds ->> 'provider' as provider,
           e.odds ->> 'details' as details,
           (e.odds ->> 'spread')::numeric(6, 2) as spread,
           (e.odds ->> 'overUnder')::numeric(6, 2) as over_under,
           e.odds ->> 'favorite' as favorite,
           (e.odds ->> 'homeMoneyline')::int as home_moneyline,
           (e.odds ->> 'awayMoneyline')::int as away_moneyline,
           (e.odds ->> 'drawMoneyline')::int as draw_moneyline
      from events e
     where e.id = any($1::bigint[]) and e.odds is not null
  ),
  latest as (
    select distinct on (s.event_id)
           s.event_id, s.provider, s.details, s.spread, s.over_under,
           s.favorite, s.home_moneyline, s.away_moneyline, s.draw_moneyline
      from event_odds_snapshots s
     where s.event_id = any($1::bigint[])
     order by s.event_id, s.observed_at desc, s.id desc
  )
  insert into event_odds_snapshots (
    event_id, provider, details, spread, over_under, favorite,
    home_moneyline, away_moneyline, draw_moneyline, captured_state
  )
  select c.event_id, c.provider, c.details, c.spread, c.over_under, c.favorite,
         c.home_moneyline, c.away_moneyline, c.draw_moneyline, c.captured_state
    from candidate c
    left join latest l on l.event_id = c.event_id
   where l.event_id is null
      or c.details        is distinct from l.details
      or c.spread         is distinct from l.spread
      or c.over_under     is distinct from l.over_under
      or c.home_moneyline is distinct from l.home_moneyline
      or c.away_moneyline is distinct from l.away_moneyline
      or c.draw_moneyline is distinct from l.draw_moneyline
  returning id`;

let league;
let eventId;

const setOdds = (odds) =>
  db.query(`update events set odds = $2::jsonb where id = $1`, [
    eventId,
    odds === null ? null : JSON.stringify(odds),
  ]);

const record = async () => (await db.query(RECORD, [[eventId]])).rows.length;

const count = async () =>
  (await one(`select count(*)::int as n from event_odds_snapshots where event_id = $1`, [eventId]))
    .n;

const LINE = {
  provider: 'DraftKings',
  details: 'SEA -3.5',
  spread: -3.5,
  overUnder: 44.5,
  favorite: 'home',
  homeMoneyline: -185,
  awayMoneyline: 154,
  drawMoneyline: null,
};

beforeAll(async () => {
  league = await one(
    `insert into leagues (provider, provider_key, sport, slug, name)
     values ('espn','football/nflz','football','football-nflz','NFL Z') returning id`,
  );
  const ev = await one(
    `insert into events (provider, provider_key, league_id, starts_at, name, state)
     values ('espn','football/nflz/1',$1, now() + interval '2 days','G','pre') returning id`,
    [league.id],
  );
  eventId = ev.id;
});

describe('writing the series', () => {
  test('the first reading is always kept', async () => {
    await setOdds(LINE);
    expect(await record()).toBe(1);
    expect(await count()).toBe(1);
  });

  /*
   * The reason the comparison is in SQL rather than in the caller. The score tick
   * polls every minute; a line moves a handful of times in the days before a game.
   */
  test('an unchanged line is not written again, however often it is polled', async () => {
    const before = await count();
    for (let i = 0; i < 20; i++) expect(await record()).toBe(0);
    expect(await count()).toBe(before);
  });

  test('a moved number is written', async () => {
    await setOdds({ ...LINE, details: 'SEA -6.5', spread: -6.5 });
    expect(await record()).toBe(1);
    const row = await one(
      `select spread, details from event_odds_snapshots
        where event_id = $1 order by observed_at desc, id desc limit 1`,
      [eventId],
    );
    expect(Number(row.spread)).toBe(-6.5);
    expect(row.details).toBe('SEA -6.5');
  });

  test('a moneyline moving on its own counts as movement', async () => {
    const before = await count();
    await setOdds({ ...LINE, details: 'SEA -6.5', spread: -6.5, homeMoneyline: -220 });
    expect(await record()).toBe(1);
    expect(await count()).toBe(before + 1);
  });

  /*
   * `null <> null` is null, which is not true. A plain inequality would therefore
   * treat "both unknown" as unchanged in some columns and never fire in others,
   * and almost every one of these fields is null for almost every fixture -- soccer
   * carries no spread, most sports carry no draw price.
   */
  test('a value appearing where there was none is movement, not silence', async () => {
    await setOdds({ ...LINE, spread: null, overUnder: null, details: 'MAN +110' });
    await record();
    const before = await count();
    await setOdds({ ...LINE, spread: null, overUnder: 2.5, details: 'MAN +110' });
    expect(await record()).toBe(1);
    expect(await count()).toBe(before + 1);
  });

  test('a value disappearing is movement too', async () => {
    await setOdds({ ...LINE, spread: null, overUnder: 2.5, details: 'MAN +110' });
    await record();
    const before = await count();
    await setOdds({ ...LINE, spread: null, overUnder: null, details: 'MAN +110' });
    expect(await record()).toBe(1);
    expect(await count()).toBe(before + 1);
  });

  /*
   * The bug that made this table useless, and the reason the cast is pinned.
   *
   * The column is numeric(6,2). The candidate was cast to bare `numeric`, so a
   * value carrying more precision than the column keeps could never equal its own
   * stored form: -3.5699999999999998 goes in, -3.57 comes back, the comparison
   * says "changed", and the row is written again. On every poll. Measured against
   * a simulated day of one-minute ticks over 40 fixtures it was 19,400 rows where
   * 280 was correct -- a 69x amplification that shows up only as a table growing.
   *
   * Real odds are quoted to one or two decimals so it might not have fired for a
   * long time, which is what makes it worth a test rather than a comment.
   */
  test('a value with more precision than the column keeps still settles', async () => {
    await setOdds({ ...LINE, spread: -3.5699999999999998, details: 'P' });
    expect(await record()).toBe(1);
    const before = await count();
    // Same number, re-observed. It must not look like movement.
    for (let i = 0; i < 5; i++) expect(await record()).toBe(0);
    expect(await count()).toBe(before);
  });

  test('a fixture with no line writes nothing at all', async () => {
    const bare = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name, state)
       values ('espn','football/nflz/2',$1, now(),'G','pre') returning id`,
      [league.id],
    );
    const n = (await db.query(RECORD, [[bare.id]])).rows.length;
    expect(n).toBe(0);
  });

  /*
   * A reading taken before kickoff is a live market. One recovered afterwards is a
   * settled number the book is no longer standing behind, and averaging the two
   * together is how a closing-line study quietly becomes wrong.
   */
  test('each reading records what the game’s state was', async () => {
    const { rows } = await db.query(
      `select distinct captured_state from event_odds_snapshots where event_id = $1`,
      [eventId],
    );
    expect(rows.map((r) => r.captured_state)).toEqual(['pre']);
  });

  test('an empty batch is not a query', async () => {
    const { rows } = await db.query(RECORD, [[]]);
    expect(rows).toHaveLength(0);
  });
});

describe('reading it back', () => {
  test('a fixture’s history comes back oldest first', async () => {
    const { rows } = await db.query(
      `select observed_at, details from event_odds_snapshots
        where event_id = $1 order by observed_at asc`,
      [eventId],
    );
    expect(rows.length).toBeGreaterThan(2);
    const times = rows.map((r) => new Date(r.observed_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test('deleting the fixture takes its history with it', async () => {
    await db.query(`delete from events where id = $1`, [eventId]);
    expect(await count()).toBe(0);
  });
});

describe('the statement under test is the one that ships', () => {
  test('the mirrored SQL matches queries.js', async () => {
    const src = await readFile(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    const at = src.indexOf('export async function recordOddsSnapshots');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('export async function oddsHistoryFor'));
    // The dedupe is the whole design; null-safety in it is the whole correctness.
    for (const clause of [
      'is distinct from',
      'distinct on (s.event_id)',
      'l.event_id is null',
      'e.odds is not null',
    ]) {
      expect(body).toContain(clause);
    }
    // Never an update: this table is append-only, and a row that can be rewritten
    // is not a record of what was true at the time.
    expect(body).not.toContain('update event_odds_snapshots');
  });

  test('both writers record, and neither can fail its own pass', async () => {
    const src = await readFile(
      new URL('../packages/sports/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    expect(src.match(/recordOddsSnapshots/g) ?? []).toHaveLength(2);
    // The archive is a by-product; a fixture list that syncs is worth more than a
    // history that is complete.
    const sweep = src.slice(src.indexOf('await q.upsertEvents'));
    expect(sweep.slice(0, 900)).toContain('try {');
  });
});
