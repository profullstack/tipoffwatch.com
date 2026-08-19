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
