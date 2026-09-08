import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Which list `/settings` manages.
 *
 * The full card -- address, name, refresh, sharing, player links -- renders for
 * `getPlaylist`, which is the first row by (position, id). Everything else got a
 * Remove button and nothing else, so a reader whose real subscription was added
 * second could only manage it by deleting the first. Measured on production: an
 * account with a 7,059-channel list added first and a 1,417,873-channel one
 * added second could not touch the second at all.
 */
let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const rows = async (sql, p) => (await db.query(sql, p)).rows;

/** The same statement queries.js runs, against a real Postgres. */
const makePrimary = (userId, playlistId) =>
  rows(
    `update user_playlists set position = coalesce(
       (select min(position) - 1 from user_playlists where user_id = $1), 0)
     where id = $2 and user_id = $1 returning id, position`,
    [userId, playlistId],
  );

const first = async (userId) =>
  (
    await rows('select id, label from user_playlists where user_id = $1 order by position, id', [
      userId,
    ])
  )[0];

describe('promoting a list', () => {
  let mine;
  let theirs;
  let a;
  let b;

  beforeAll(async () => {
    [mine] = await rows(`insert into users (email) values ('one@example.com') returning id`);
    [theirs] = await rows(`insert into users (email) values ('two@example.com') returning id`);
    [a] = await rows(
      `insert into user_playlists (user_id, label, source_url, position)
       values ($1,'kyle','enc:a',0) returning id`,
      [mine.id],
    );
    [b] = await rows(
      `insert into user_playlists (user_id, label, source_url, position)
       values ($1,'argon','enc:b',1) returning id`,
      [mine.id],
    );
  });

  test('the second list can be moved into the manageable slot', async () => {
    expect((await first(mine.id)).label).toBe('kyle');
    await makePrimary(mine.id, b.id);
    expect((await first(mine.id)).label).toBe('argon');
  });

  test('promoting is repeatable and does not collide', async () => {
    // min(position) - 1 each time, so two promotions in a row still order right.
    await makePrimary(mine.id, a.id);
    expect((await first(mine.id)).label).toBe('kyle');
    await makePrimary(mine.id, b.id);
    expect((await first(mine.id)).label).toBe('argon');
  });

  test('it moves ONE row, not every list the reader has', async () => {
    // The fan-out this table has already been bitten by: `where user_id` alone
    // renumbers everything.
    const before = await rows(
      'select id, position from user_playlists where user_id = $1 order by id',
      [mine.id],
    );
    await makePrimary(mine.id, b.id);
    const after = await rows(
      'select id, position from user_playlists where user_id = $1 order by id',
      [mine.id],
    );
    const changed = after.filter((r) => before.find((x) => x.id === r.id)?.position !== r.position);
    expect(changed).toHaveLength(1);
    expect(changed[0].id).toBe(b.id);
  });

  test("somebody else's list cannot be promoted", async () => {
    const [theirList] = await rows(
      `insert into user_playlists (user_id, label, source_url, position)
       values ($1,'not yours','enc:c',0) returning id`,
      [theirs.id],
    );
    expect(await makePrimary(mine.id, theirList.id)).toHaveLength(0);
    // And theirs is untouched.
    expect((await first(theirs.id)).label).toBe('not yours');
  });
});

describe('the settings page offers it', () => {
  test('every other line has a Manage action, not only Remove', async () => {
    const view = await readFile(
      new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(view).toContain('/api/playlist/primary');
    expect(view).toContain('id="your-list"');
  });

  test('the route checks ownership the way Remove does', async () => {
    const app = await readFile(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');
    const route = app.slice(app.indexOf("app.post('/api/playlist/primary'"));
    const body = route.slice(0, route.indexOf('\n});'));
    expect(body).toContain('getPlaylistFor');
    expect(body).toContain('requireUser');
    // An id is required. Without one this would mean "all of them".
    expect(body).toContain('Say which list to manage.');
  });
});
