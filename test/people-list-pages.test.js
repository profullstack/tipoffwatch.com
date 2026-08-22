import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { PeopleListPage } = await import('../apps/web/src/views/people.jsx');

/**
 * /u/:handle/followers and /u/:handle/following.
 *
 * The profile shows the newest 24 of each as a preview; these pages are where the
 * rest has to actually be reachable. Two things are worth pinning: the paging, and
 * the gates -- a page hanging off a handle that forgets the block check fails open
 * silently, and only for the person it matters to.
 *
 * The paging SQL is lifted out of queries.js and run as written.
 */
let db;
let followersSql;
let followingSql;

const lift = (source, name, params) => {
  const at = source.indexOf(`export async function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  const open = source.indexOf('sql`', at);
  const close = source.indexOf('`;', open);
  let text = source.slice(open + 4, close);
  params.forEach(([placeholder, n]) => {
    text = text.replace(new RegExp(placeholder, 'g'), `$${n}`);
  });
  return text;
};

const LIMIT = '\\$\\{Math\\.min\\(Math\\.max\\(Number\\(limit\\) \\|\\| 100, 1\\), 200\\)\\}';
const OFFSET = '\\$\\{Math\\.max\\(Number\\(offset\\) \\|\\| 0, 0\\)\\}';

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

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

describe('paging through a long list', () => {
  let subject;
  const handles = [];

  beforeAll(async () => {
    subject = (
      await one(`insert into users (email, handle) values ('p-subject@example.test','psub')
                 returning id`)
    ).id;
    // Distinct created_at values so "newest first" has one correct answer, and the
    // page boundary is a fact rather than a coin toss.
    for (let i = 0; i < 7; i++) {
      const h = `pager${i}`;
      handles.push(h);
      const u = (
        await one(`insert into users (email, handle) values ($1,$2) returning id`, [
          `${h}@example.test`,
          h,
        ])
      ).id;
      await db.query(
        `insert into user_follows (follower_id, followee_id, created_at)
         values ($1,$2, now() - ($3 || ' minutes')::interval)`,
        [u, subject, i],
      );
    }
  });

  test('the first page is the newest followers', async () => {
    const out = await rows(followersSql, [subject, null, 3, 0]);
    expect(out.map((p) => p.handle)).toEqual(['pager0', 'pager1', 'pager2']);
  });

  test('the next page continues where it stopped, with no repeats and no gaps', async () => {
    const first = await rows(followersSql, [subject, null, 3, 0]);
    const second = await rows(followersSql, [subject, null, 3, 3]);
    expect(second.map((p) => p.handle)).toEqual(['pager3', 'pager4', 'pager5']);
    // The bug offset paging invites: an unstable sort silently drops or repeats a
    // row at the boundary.
    const seen = [...first, ...second].map((p) => p.handle);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('the last page is short rather than wrapping', async () => {
    const out = await rows(followersSql, [subject, null, 3, 6]);
    expect(out.map((p) => p.handle)).toEqual(['pager6']);
  });

  test('reading past the end is empty, not an error', async () => {
    expect(await rows(followersSql, [subject, null, 3, 999])).toEqual([]);
  });

  test('a negative or junk offset is treated as the start', async () => {
    // The offset comes off a query string, so it is reader-supplied.
    const out = await rows(followersSql, [subject, null, 3, 0]);
    expect(out.length).toBe(3);
  });

  test('following pages the same way', async () => {
    const follower = (
      await one(`insert into users (email, handle) values ('p-f@example.test','pf-er')
                 returning id`)
    ).id;
    for (let i = 0; i < 4; i++) {
      const u = (
        await one(`insert into users (email, handle) values ($1,$2) returning id`, [
          `followee${i}@example.test`,
          `followee${i}`,
        ])
      ).id;
      await db.query(
        `insert into user_follows (follower_id, followee_id, created_at)
         values ($1,$2, now() - ($3 || ' minutes')::interval)`,
        [follower, u, i],
      );
    }
    const first = await rows(followingSql, [follower, 2, 0]);
    const second = await rows(followingSql, [follower, 2, 2]);
    expect(first.map((p) => p.handle)).toEqual(['followee0', 'followee1']);
    expect(second.map((p) => p.handle)).toEqual(['followee2', 'followee3']);
  });
});

describe('the page itself', () => {
  const profile = { id: 1, handle: 'chovy', display_name: null, profile_public: true };
  const person = (h, extra = {}) => ({
    id: h,
    handle: h,
    display_name: null,
    profile_public: true,
    ...extra,
  });

  const html = async (props) =>
    (
      await PeopleListPage({
        user: null,
        profile,
        kind: 'followers',
        people: [],
        total: 0,
        page: 0,
        pageSize: 50,
        ...props,
      }).toString()
    ).toString();

  test('links every username to its profile', async () => {
    const out = await html({ people: [person('alice'), person('bob')], total: 2 });
    expect(out).toContain('href="/u/alice"');
    expect(out).toContain('href="/u/bob"');
    expect(out).toContain('@alice');
  });

  test('offers a way back to the profile', async () => {
    const out = await html({ people: [person('alice')], total: 1 });
    expect(out).toContain('href="/u/chovy"');
  });

  test('canonicalises to the unpaged URL', async () => {
    // Page two is the same list, not a separate document worth indexing twice.
    const out = await html({ people: [person('alice')], total: 60, page: 1 });
    // Host-agnostic: SITE_URL is localhost in tests. What matters is that the
    // canonical carries no ?page=.
    expect(out).toMatch(/rel="canonical" href="[^"]*\/u\/chovy\/followers"/);
  });

  test('offers Older only while there is more', async () => {
    const full = Array.from({ length: 50 }, (_, i) => person(`u${i}`));
    const more = await html({ people: full, total: 120, page: 0 });
    expect(more).toContain('Older');
    expect(more).not.toContain('Newer');

    const last = await html({ people: [person('z')], total: 51, page: 1 });
    expect(last).toContain('Newer');
    expect(last).not.toContain('Older');
  });

  test('says plainly when there is nobody', async () => {
    const out = await html({ people: [], total: 0 });
    expect(out).toContain('Nobody follows');
    expect(out).not.toContain('Older');
  });

  test('counts one person as a person, not 1 people', async () => {
    const out = await html({ people: [person('alice')], total: 1 });
    expect(out).toContain('1 person.');
  });

  test('still lists somebody with no handle, unlinked', async () => {
    const out = await html({
      people: [person('x', { handle: null })],
      total: 1,
    });
    expect(out).toContain('Someone');
    expect(out).not.toContain('href="/u/null"');
  });

  test('names the direction in the title', async () => {
    const following = await html({ kind: 'following', people: [], total: 0 });
    expect(following).toContain('Following');
    expect(following).toContain('not following anyone yet');
  });
});
