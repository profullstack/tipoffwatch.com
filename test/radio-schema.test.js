import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

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
      db.query('insert into siriusxm_sessions (user_id, access_token) values ($1, $2)', [u.id, 'x']),
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
    ]);
  });
});

describe('proxy pinning', () => {
  test('a reader always exits the same entry, and readers spread across the pool', async () => {
    process.env.SIRIUSXM_PROXIES = Array.from({ length: 8 }, (_, i) => `http://u:p@h${i}:1`).join(',');
    const { proxyFor } = await import('../packages/radio/src/session.js');
    const a = proxyFor('11111111-1111-1111-1111-111111111111');
    expect(proxyFor('11111111-1111-1111-1111-111111111111')).toBe(a);
    const seen = new Set(
      Array.from({ length: 40 }, (_, i) => proxyFor(`user-${i}`)),
    );
    expect(seen.size).toBeGreaterThan(3);
    delete process.env.SIRIUSXM_PROXIES;
    process.env.SIRIUSXM_PROXY_URL = 'http://rotate:1';
    expect(proxyFor('anyone')).toBe('http://rotate:1');
    delete process.env.SIRIUSXM_PROXY_URL;
  });
});
