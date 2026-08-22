import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { ProfilePage } = await import('../apps/web/src/views/people.jsx');

/**
 * The followers and following sections, and the number above them.
 *
 * The bug this was written for: a profile read "1 Followers" directly above the
 * words "Nobody yet." profileCounts counted rows in user_follows outright, while
 * followersOf filtered to accounts that have picked a handle -- so a follower who
 * had never chosen one was counted and then not listed. Nothing errored; the page
 * just contradicted itself, and the number looked like the authoritative half.
 *
 * The SQL is lifted out of queries.js and run as written, so an edit to the shipped
 * query is what gets tested.
 */
let db;
let countsSql;
let followersSql;
let followingSql;

const lift = (source, name, params) => {
  const at = source.indexOf(`export async function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  const open = source.indexOf('sql`', at);
  const close = source.indexOf('`;', open);
  let text = source.slice(open + 4, close);
  // Regexes rather than string literals: these are template placeholders, and
  // writing them out trips the lint rule that hunts for accidental ones.
  params.forEach(([placeholder, n]) => {
    text = text.replace(new RegExp(placeholder, 'g'), `$${n}`);
  });
  return text;
};

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const source = await readFile(
    new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    'utf8',
  );
  countsSql = lift(source, 'profileCounts', [
    ['\\$\\{userId\\}', 1],
    ['\\$\\{viewerId\\}', 2],
  ]);
  followersSql = lift(source, 'followersOf', [
    ['\\$\\{userId\\}', 1],
    ['\\$\\{viewerId\\}', 2],
    [LIMIT, 3],
    [OFFSET, 4],
  ]);
  followingSql = lift(source, 'followingBy', [
    ['\\$\\{userId\\}', 1],
    [LIMIT, 2],
    [OFFSET, 3],
  ]);
}, 60_000);

// The limit and offset expressions as they are written in queries.js. Named
// because both list queries share them, and because a change to either is the
// thing that breaks this file loudly rather than quietly.
const LIMIT = '\\$\\{Math\\.min\\(Math\\.max\\(Number\\(limit\\) \\|\\| 100, 1\\), 200\\)\\}';
const OFFSET = '\\$\\{Math\\.max\\(Number\\(offset\\) \\|\\| 0, 0\\)\\}';

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

const mkUser = async (email, handle, { profilePublic = true } = {}) =>
  (
    await one(`insert into users (email, handle, profile_public) values ($1,$2,$3) returning id`, [
      email,
      handle,
      profilePublic,
    ])
  ).id;

const follow = (a, b) =>
  db.query(`insert into user_follows (follower_id, followee_id) values ($1,$2)`, [a, b]);

const counts = async (userId, viewerId = null) => one(countsSql, [userId, viewerId]);
const followers = async (userId, viewerId = null) => rows(followersSql, [userId, viewerId, 24, 0]);
const following = async (userId) => rows(followingSql, [userId, 24, 0]);

describe('the number and the list agree', () => {
  let subject;

  beforeAll(async () => {
    subject = await mkUser('subject@example.test', 'subject');
  });

  test('a follower who never picked a handle is counted AND listed', async () => {
    // The production bug, and then its overcorrection. A magic link makes an
    // account without asking for a handle, so this is an ordinary signed-up person
    // who followed somebody -- not a broken row. Dropping them made the profile
    // report fewer followers than it has, which is the one thing a follower count
    // must not do.
    const anon = await mkUser('anon@example.test', null);
    await follow(anon, subject);

    expect((await counts(subject)).followers).toBe(1);
    expect((await followers(subject)).map((p) => p.id)).toEqual([anon]);
  });

  test('a follower with a handle is counted and listed too', async () => {
    const named = await mkUser('named@example.test', 'named');
    await follow(named, subject);

    expect((await counts(subject)).followers).toBe(2);
    expect((await followers(subject)).map((p) => p.handle)).toContain('named');
  });

  test('the same holds for who somebody follows', async () => {
    const follower = await mkUser('follower@example.test', 'follower');
    const anon = await mkUser('anon2@example.test', null);
    const named = await mkUser('named2@example.test', 'named2');
    await follow(follower, anon);
    await follow(follower, named);

    expect((await counts(follower)).following).toBe(2);
    expect((await following(follower)).map((p) => p.id).sort()).toEqual([anon, named].sort());
  });

  test('a blocked follower is hidden from the count as well as the list', async () => {
    // followersOf has always filtered these out. The count did not, so a blocked
    // viewer saw a number they could not account for. This is the one thing the
    // count is still allowed to leave out, because it is per-viewer.
    const viewer = await mkUser('viewer@example.test', 'viewer');
    const blocker = await mkUser('blocker@example.test', 'blocker');
    await follow(blocker, subject);
    await db.query(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2)`, [
      blocker,
      viewer,
    ]);

    expect((await counts(subject, viewer)).followers).toBe(2);
    expect((await followers(subject, viewer)).map((p) => p.id)).not.toContain(blocker);
    // ...and everyone else still sees all three.
    expect((await counts(subject)).followers).toBe(3);
  });

  test('the count equals the length of the list it sits above', async () => {
    // The invariant both earlier bugs broke, stated directly rather than implied by
    // the numbers above.
    const n = (await counts(subject)).followers;
    expect((await followers(subject)).length).toBe(n);
  });
});

describe('what the list carries', () => {
  test('it reports whether each person has a page to link to', async () => {
    const subject = await mkUser('pub@example.test', 'pub');
    const shown = await mkUser('shown@example.test', 'shown', { profilePublic: true });
    const hidden = await mkUser('hidden@example.test', 'hidden', { profilePublic: false });
    await follow(shown, subject);
    await follow(hidden, subject);

    const out = await followers(subject);
    expect(out.find((p) => p.handle === 'shown').profile_public).toBe(true);
    expect(out.find((p) => p.handle === 'hidden').profile_public).toBe(false);
  });
});

describe('how the page renders people', () => {
  const html = async (props) =>
    (
      await ProfilePage({
        user: null,
        profile: { id: 1, handle: 'x', display_name: null, bio: null, profile_public: true },
        counts: { followers: 2, following: 0, teams: 0 },
        followers: [],
        following: [],
        isFollowing: false,
        isSelf: false,
        ...props,
      }).toString()
    ).toString();

  test('links somebody whose profile is public', async () => {
    const out = await html({
      followers: [{ id: 2, handle: 'shown', display_name: null, profile_public: true }],
    });
    expect(out).toContain('href="/u/shown"');
  });

  test('names, but does not link, somebody who hid their profile', async () => {
    // /u/:handle answers 404 for a hidden profile, so a link here would be a dead
    // link on a public page.
    const out = await html({
      followers: [{ id: 3, handle: 'hidden', display_name: null, profile_public: false }],
    });
    expect(out).toContain('@hidden');
    expect(out).not.toContain('href="/u/hidden"');
  });

  test('prefers a display name over the handle', async () => {
    const out = await html({
      followers: [{ id: 4, handle: 'h', display_name: 'Real Name', profile_public: true }],
    });
    expect(out).toContain('Real Name');
  });

  test('shows a follower who has set no name at all, without inventing one', async () => {
    const out = await html({
      followers: [{ id: 5, handle: null, display_name: null, profile_public: true }],
    });
    expect(out).toContain('Someone');
    // Not "@null", which is what naming them by handle produced.
    expect(out).not.toContain('@null');
    // And not a link: there is no URL to build without a handle.
    expect(out).not.toContain('href="/u/null"');
    expect(out).not.toContain('<p class="empty">Nobody yet.</p>');
  });

  test('uses a display name even when there is no handle', async () => {
    // Somebody can set a name in Settings without claiming a handle.
    const out = await html({
      followers: [{ id: 6, handle: null, display_name: 'Named Only', profile_public: true }],
    });
    expect(out).toContain('Named Only');
    expect(out).not.toContain('Someone');
  });
});
