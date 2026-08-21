import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Re-fetching channel lists on a schedule.
 *
 * The provider supports no conditional request -- measured 2026-08-21: no ETag, no
 * Last-Modified, and If-Modified-Since answered with a full 200 -- so the download
 * cannot be avoided and every one is the whole ~800KB file. Everything worth
 * testing here is about not wasting the OTHER resources: the database write when
 * nothing changed, and the fetch itself when the provider is failing.
 */
let db;
let user;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  user = (await db.query(`insert into users (email) values ('a@example.test') returning id`))
    .rows[0].id;
  await db.query(
    `insert into user_playlists (user_id, label, source_url) values ($1, 'l', 'sealed')`,
    [user],
  );
}, 60_000);

const due = async () =>
  (
    await db.query(
      `select user_id from user_playlists
        where refresh_after is null or refresh_after <= now()`,
    )
  ).rows.length;

describe('what is due', () => {
  test('a list that has never been polled is due immediately', async () => {
    // refresh_after is null for a list added before this column existed and for one
    // added a second ago; both should be picked up on the next tick.
    expect(await due()).toBe(1);
  });

  test('a freshly polled list is not due again until its interval', async () => {
    await db.query(
      `update user_playlists set refresh_after = now() + interval '5 minutes' where user_id = $1`,
      [user],
    );
    expect(await due()).toBe(0);
  });
});

describe('failing providers are backed off, not retried every tick', () => {
  test('the wait grows with the streak', async () => {
    // There is no point pulling 800KB every five minutes from something answering
    // 404, and hammering a dead line is how the account behind it gets noticed.
    const waits = [];
    await db.query(`update user_playlists set error_streak = 0 where user_id = $1`, [user]);
    for (let i = 0; i < 4; i++) {
      await db.query(
        `update user_playlists set
           error_streak = least(error_streak + 1, 8),
           refresh_after = now() + (least(power(2, least(error_streak + 1, 6))::int, 60) || ' minutes')::interval
         where user_id = $1`,
        [user],
      );
      const { rows } = await db.query(
        `select error_streak, extract(epoch from (refresh_after - now()))/60 as mins
           from user_playlists where user_id = $1`,
        [user],
      );
      waits.push(Math.round(rows[0].mins));
    }
    // 2, 4, 8, 16 minutes -- strictly increasing.
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(waits[0]).toBeLessThan(waits[waits.length - 1]);
  });

  test('the wait is capped, so a list is never abandoned', async () => {
    await db.query(`update user_playlists set error_streak = 8 where user_id = $1`, [user]);
    await db.query(
      `update user_playlists set
         refresh_after = now() + (least(power(2, least(error_streak + 1, 6))::int, 60) || ' minutes')::interval
       where user_id = $1`,
      [user],
    );
    const { rows } = await db.query(
      `select extract(epoch from (refresh_after - now()))/60 as mins
         from user_playlists where user_id = $1`,
      [user],
    );
    expect(Math.round(rows[0].mins)).toBeLessThanOrEqual(60);
  });

  test('a success clears the streak', async () => {
    await db.query(
      `update user_playlists set error_streak = 0, last_error = null, content_hash = 'abc'
       where user_id = $1`,
      [user],
    );
    const { rows } = await db.query(
      `select error_streak, last_error from user_playlists where user_id = $1`,
      [user],
    );
    expect(rows[0].error_streak).toBe(0);
    expect(rows[0].last_error).toBeNull();
  });
});

describe('the code that avoids the pointless write', () => {
  test('an unchanged body skips the channel rewrite entirely', async () => {
    const src = await readFile(
      new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    // 288 delete-and-reinsert cycles a day over 7,000 rows, for a file that changes
    // a dozen times, is the cost this avoids.
    expect(src).toContain('createHash');
    expect(src).toContain('knownHash === contentHash');
    expect(src).toContain('unchanged: true');
  });

  test('polling is sequential, not fanned out', async () => {
    const src = await readFile(
      new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    // Several ~800KB pulls at once from one datacenter IP is the traffic pattern
    // that gets a line cut off, so the loop is deliberately serial.
    expect(src).toContain('for (const row of due)');
    expect(src).not.toContain('Promise.all(due');
  });

  test('the next poll is jittered so lists do not sync up', async () => {
    const src = await readFile(
      new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toContain('function nextRefreshAt');
    expect(src).toContain('Math.random()');
  });
});
