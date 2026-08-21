import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { HANDLE_RE, handleAvailableShape } from '../packages/db/src/queries.js';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Profiles, following people, and messages.
 *
 * The rules worth pinning are the ones that are quiet when broken: a handle that
 * shadows a real route, a follow pointing at a deleted account, a block that stops
 * messages in one direction but not the other, and a thread query that returns half
 * a conversation because it only matched one ordering of the pair.
 */

let db;
let alice;
let bob;
let carol;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  const mk = async (email, handle) =>
    (
      await db.query(`insert into users (email, handle) values ($1, $2) returning id`, [
        email,
        handle,
      ])
    ).rows[0].id;
  alice = await mk('alice@example.test', 'alice');
  bob = await mk('bob@example.test', 'bob');
  carol = await mk('carol@example.test', 'carol');
}, 60_000);

describe('handles', () => {
  test('a reasonable handle is allowed', () => {
    for (const h of ['alice', 'bob_99', 'a_b_c', 'Anthony']) {
      expect(handleAvailableShape(h)).toBe(true);
    }
  });

  test('a handle cannot shadow a real route', () => {
    // /u/settings would be a profile sitting on top of a page that already exists.
    for (const h of ['settings', 'login', 'api', 'messages', 'events', 'admin']) {
      expect(handleAvailableShape(h)).toBe(false);
    }
  });

  test('junk is rejected', () => {
    for (const h of ['', 'ab', 'a'.repeat(31), 'has space', 'has-dash', '_leading', 'trailing_']) {
      expect(handleAvailableShape(h)).toBe(false);
    }
  });

  test('the pattern and the reserved list are separate checks', () => {
    // "settings" is a perfectly well-formed handle; it is refused for the other
    // reason, and conflating the two would let a rename of one silently drop it.
    expect(HANDLE_RE.test('settings')).toBe(true);
    expect(handleAvailableShape('settings')).toBe(false);
  });

  test('handles are unique case-insensitively', async () => {
    // citext, so "Alice" must not be a second account beside "alice".
    await expect(
      db.query(`insert into users (email, handle) values ('x@example.test', 'ALICE')`),
    ).rejects.toThrow();
  });
});

describe('following people', () => {
  test('a follow is recorded once', async () => {
    await db.query(
      `insert into user_follows (follower_id, followee_id) values ($1, $2)
       on conflict do nothing`,
      [alice, bob],
    );
    await db.query(
      `insert into user_follows (follower_id, followee_id) values ($1, $2)
       on conflict do nothing`,
      [alice, bob],
    );
    const { rows } = await db.query(
      `select count(*)::int as n from user_follows where follower_id = $1 and followee_id = $2`,
      [alice, bob],
    );
    expect(rows[0].n).toBe(1);
  });

  test('following yourself is refused by the database, not just the route', async () => {
    await expect(
      db.query(`insert into user_follows (follower_id, followee_id) values ($1, $1)`, [alice]),
    ).rejects.toThrow();
  });

  test('deleting an account removes the edges pointing at it', async () => {
    const tmp = (
      await db.query(
        `insert into users (email, handle) values ('t@example.test','tmp') returning id`,
      )
    ).rows[0].id;
    await db.query(`insert into user_follows (follower_id, followee_id) values ($1, $2)`, [
      alice,
      tmp,
    ]);
    await db.query(`delete from users where id = $1`, [tmp]);
    const { rows } = await db.query(
      `select count(*)::int as n from user_follows where followee_id = $1`,
      [tmp],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('messages', () => {
  test('a thread is the union of both directions', async () => {
    await db.query(
      `insert into messages (sender_id, recipient_id, body) values ($1,$2,'hi'),($2,$1,'hello back')`,
      [alice, bob],
    );
    // The bug this guards: matching only (sender=a and recipient=b) returns half
    // the conversation and looks like the other person never replied.
    const { rows } = await db.query(
      `select body from messages
        where (sender_id = $1 and recipient_id = $2) or (sender_id = $2 and recipient_id = $1)
        order by created_at`,
      [alice, bob],
    );
    expect(rows.map((r) => r.body)).toEqual(['hi', 'hello back']);
  });

  test('an empty or whitespace-only message is refused', async () => {
    await expect(
      db.query(`insert into messages (sender_id, recipient_id, body) values ($1,$2,'   ')`, [
        alice,
        bob,
      ]),
    ).rejects.toThrow();
  });

  test('you cannot message yourself', async () => {
    await expect(
      db.query(`insert into messages (sender_id, recipient_id, body) values ($1,$1,'note')`, [
        alice,
      ]),
    ).rejects.toThrow();
  });

  test('unread counts only the recipient side', async () => {
    const { rows } = await db.query(
      `select count(*)::int as n from messages where recipient_id = $1 and read_at is null`,
      [bob],
    );
    // Alice sent one to Bob; Bob's own reply must not count towards his own badge.
    expect(rows[0].n).toBe(1);
  });
});

describe('blocking', () => {
  test('a block is found from either side', async () => {
    await db.query(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2)`, [
      carol,
      alice,
    ]);
    for (const [a, b] of [
      [carol, alice],
      [alice, carol],
    ]) {
      const { rows } = await db.query(
        `select 1 from user_blocks
          where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)`,
        [a, b],
      );
      // Checking one direction only is how a blocked account keeps messaging.
      expect(rows).toHaveLength(1);
    }
  });

  test('blocking cannot be aimed at yourself', async () => {
    await expect(
      db.query(`insert into user_blocks (blocker_id, blocked_id) values ($1,$1)`, [alice]),
    ).rejects.toThrow();
  });
});

describe('profile privacy', () => {
  test('a profile is public by default but can be turned off', async () => {
    const { rows } = await db.query(`select profile_public from users where id = $1`, [alice]);
    expect(rows[0].profile_public).toBe(true);
    await db.query(`update users set profile_public = false where id = $1`, [alice]);
    const after = await db.query(`select profile_public from users where id = $1`, [alice]);
    expect(after.rows[0].profile_public).toBe(false);
  });

  test('a handle is not derived from the email address', async () => {
    // Publishing the local part of everyone's address is a privacy leak wearing a
    // convenience costume, so an account starts with no handle at all.
    const fresh = (
      await db.query(`insert into users (email) values ('secret.person@example.test') returning id`)
    ).rows[0].id;
    const { rows } = await db.query(`select handle from users where id = $1`, [fresh]);
    expect(rows[0].handle).toBeNull();
  });
});

describe('a profile is reachable from the site, not only by URL', () => {
  test('comments carry the author handle so the name can link', async () => {
    const q = await readFile(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    const fn = q.slice(q.indexOf('export async function commentsForEvent'));
    expect(fn.slice(0, 700)).toContain('u.handle');
    expect(fn.slice(0, 700)).toContain('u.display_name');
  });

  test('a handle replaces the email fragment a comment used to be signed with', async () => {
    const src = await readFile(
      new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
      'utf8',
    );
    // The regression: every public comment was signed with the local part of the
    // author's address, which nobody chose to publish. It is a fallback now.
    expect(src).toContain('function commenterName');
    expect(src).toContain('c.display_name ||');
  });

  test('a hidden profile is named but not linked', async () => {
    const src = await readFile(
      new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
      'utf8',
    );
    // profile_public === false must not become a link to a 404.
    expect(src).toContain('c.profile_public !== false');
  });

  test('the header links your own profile once you have a handle', async () => {
    const src = await readFile(
      new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toContain('props.user?.handle');
    expect(src).toContain('Profile</a>');
  });
});
