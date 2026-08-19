import { beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Proves the array literal this app builds is one real Postgres accepts.
 *
 * The bug it guards: Bun's parameter serialiser stringifies a JS array with
 * Array.prototype.toString, so ['internal','hybrid'] arrived as `internal,hybrid`
 * and Postgres rejected it — which silently broke passkey registration, saving
 * reminder preferences, and the fan-out's user lookup, each with a different
 * unhelpful error.
 */
let pgArray;
let db;

beforeAll(async () => {
  ({ pgArray } = await import('../packages/db/src/queries.js'));
  db = await new PGlite();
  await db.exec(`
    create table t (id serial primary key, tags text[], nums int[]);
  `);
}, 60_000);

describe('pgArray', () => {
  test('builds a literal Postgres round-trips as text[]', async () => {
    const value = ['internal', 'hybrid'];
    await db.query('insert into t (tags) values ($1::text[])', [pgArray(value)]);
    const { rows } = await db.query('select tags from t order by id desc limit 1');
    expect(rows[0].tags).toEqual(value);
  });

  test('round-trips numbers as int[]', async () => {
    await db.query('insert into t (nums) values ($1::int[])', [pgArray([60, 1])]);
    const { rows } = await db.query('select nums from t order by id desc limit 1');
    expect(rows[0].nums).toEqual([60, 1]);
  });

  test('an empty array is empty, not a one-element array of ""', async () => {
    await db.query('insert into t (tags) values ($1::text[])', [pgArray([])]);
    const { rows } = await db.query('select tags from t order by id desc limit 1');
    expect(rows[0].tags).toEqual([]);
  });

  test('escapes quotes and backslashes rather than corrupting the literal', async () => {
    const nasty = ['a"b', 'c\\d', 'e,f', '{g}'];
    await db.query('insert into t (tags) values ($1::text[])', [pgArray(nasty)]);
    const { rows } = await db.query('select tags from t order by id desc limit 1');
    expect(rows[0].tags).toEqual(nasty);
  });

  test('the raw JS-array stringification Postgres rejected is not what we send', () => {
    // `['internal','hybrid'].toString()` === 'internal,hybrid' — the exact value
    // that appeared in the production error.
    expect(pgArray(['internal', 'hybrid'])).not.toBe('internal,hybrid');
    expect(pgArray(['internal', 'hybrid'])).toBe('{"internal","hybrid"}');
  });

  test('handles uuids, which the fan-out passes as uuid[]', async () => {
    const ids = ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', '9c858901-8a57-4791-81fe-4c455b099bc9'];
    const { rows } = await db.query('select $1::uuid[] as ids', [pgArray(ids)]);
    expect(rows[0].ids).toEqual(ids);
  });
});

describe('score updates', () => {
  test('nulls arrive as SQL NULL, not the string "null"', async () => {
    // A score before kickoff, or a clock for a sport that has none, is null. Quoted
    // as "null" it either fails the int[] cast or stores a bogus value.
    const { rows } = await db.query('select $1::int[] as scores', [pgArray([3, null, 0])]);
    expect(rows[0].scores).toEqual([3, null, 0]);
  });

  test('column-wise unnest updates the right rows', async () => {
    await db.exec(`
      create table ev (id serial primary key, provider text, provider_key text,
                       state text, home_score int, away_score int);
      insert into ev (provider, provider_key, state, home_score, away_score) values
        ('espn','a/1','pre',null,null),
        ('espn','a/2','pre',null,null),
        ('espn','a/3','pre',null,null);
    `);

    // The shape that replaced `from (values ${sql(rows)})`, which failed at runtime
    // with "Cannot use array of objects for UPDATE" and froze every live score.
    await db.query(
      `update ev e set state = v.state, home_score = v.home_score, away_score = v.away_score
       from (select * from unnest($1::text[], $2::text[], $3::int[], $4::int[])
             as t(provider_key, state, home_score, away_score)) v
       where e.provider_key = v.provider_key`,
      [pgArray(['a/1', 'a/3']), pgArray(['in', 'post']), pgArray([2, 5]), pgArray([1, null])],
    );

    const { rows } = await db.query(
      'select provider_key, state, home_score, away_score from ev order by id',
    );
    expect(rows[0]).toMatchObject({ state: 'in', home_score: 2, away_score: 1 });
    // Untouched: an update must only hit the keys it was given.
    expect(rows[1]).toMatchObject({ state: 'pre', home_score: null });
    expect(rows[2]).toMatchObject({ state: 'post', home_score: 5, away_score: null });
  });
});
