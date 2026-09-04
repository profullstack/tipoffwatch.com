import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';
process.env.PLAYLIST_SECRET ??= 'test-secret-for-sealing-values';

let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);
afterAll(() => db?.close());

describe('siriusxm_sessions', () => {
  test('one per account, and it goes with the account', async () => {
    const {
      rows: [u],
    } = await db.query("insert into users (email) values ('r@example.com') returning id");
    await db.query(
      'insert into siriusxm_sessions (user_id, email, access_token, session_cookies) values ($1, $2, $3, $4)',
      [u.id, 'r@sxm', 'v1.sealed', 'v1.sealed'],
    );
    await expect(
      db.query('insert into siriusxm_sessions (user_id, access_token) values ($1, $2)', [
        u.id,
        'x',
      ]),
    ).rejects.toThrow();
    await db.query('delete from users where id = $1', [u.id]);
    const { rows } = await db.query('select count(*)::int as n from siriusxm_sessions');
    expect(rows[0].n).toBe(0);
  });

  test('the sealed columns are text with no plaintext sibling', async () => {
    const { rows } = await db.query(
      "select column_name from information_schema.columns where table_name = 'siriusxm_sessions' order by ordinal_position",
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'user_id',
      'email',
      'access_token',
      'session_cookies',
      'access_token_expires_at',
      'refresh_token_expires_at',
      'created_at',
      'updated_at',
      // Sharing (0031). None of these is a secret: a flag, an audience, a
      // timestamp and a label the owner wrote to be shown to other people.
      'shared',
      'share_audience',
      'shared_at',
      'shared_label',
    ]);
  });

  test('a line is shared exactly when its audience says so, and grants go with the line', async () => {
    const {
      rows: [owner],
    } = await db.query("insert into users (email) values ('o@example.com') returning id");
    const {
      rows: [friend],
    } = await db.query("insert into users (email) values ('f@example.com') returning id");
    await db.query(
      'insert into siriusxm_sessions (user_id, access_token, session_cookies) values ($1, $2, $3)',
      [owner.id, 'v1.sealed', 'v1.sealed'],
    );
    // The two columns must agree: open with no audience, or private with one, is refused.
    await expect(
      db.query('update siriusxm_sessions set shared = true where user_id = $1', [owner.id]),
    ).rejects.toThrow();
    await expect(
      db.query("update siriusxm_sessions set share_audience = 'everyone' where user_id = $1", [
        owner.id,
      ]),
    ).rejects.toThrow();
    await db.query(
      "update siriusxm_sessions set shared = true, share_audience = 'friends' where user_id = $1",
      [owner.id],
    );
    await db.query(
      'insert into siriusxm_share_grants (owner_user_id, audience_user_id) values ($1, $2)',
      [owner.id, friend.id],
    );
    // A grant needs a line to attach to.
    await expect(
      db.query(
        'insert into siriusxm_share_grants (owner_user_id, audience_user_id) values ($1, $2)',
        [friend.id, owner.id],
      ),
    ).rejects.toThrow();
    // Disconnecting the line takes its grants with it.
    await db.query('delete from siriusxm_sessions where user_id = $1', [owner.id]);
    const { rows } = await db.query('select count(*)::int as n from siriusxm_share_grants');
    expect(rows[0].n).toBe(0);
    await db.query('delete from users where id in ($1, $2)', [owner.id, friend.id]);
  });
});

describe('proxy pinning', () => {
  test('a reader always exits the same entry, and readers spread across the pool', async () => {
    process.env.SIRIUSXM_PROXIES = Array.from({ length: 8 }, (_, i) => `http://u:p@h${i}:1`).join(
      ',',
    );
    const { proxyFor } = await import('../packages/radio/src/session.js');
    const a = proxyFor('11111111-1111-1111-1111-111111111111');
    expect(proxyFor('11111111-1111-1111-1111-111111111111')).toBe(a);
    const seen = new Set(Array.from({ length: 40 }, (_, i) => proxyFor(`user-${i}`)));
    expect(seen.size).toBeGreaterThan(3);
    delete process.env.SIRIUSXM_PROXIES;
    process.env.SIRIUSXM_PROXY_URL = 'http://rotate:1';
    expect(proxyFor('anyone')).toBe('http://rotate:1');
    delete process.env.SIRIUSXM_PROXY_URL;
  });
});
