import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Following every league at once.
 *
 * The rules that matter are about what it must NOT do: sweep away team follows
 * somebody chose one at a time, double-count on a second press, or pick up leagues
 * that are no longer active.
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

  for (const [key, active] of [
    ['baseball/mlb', true],
    ['football/nfl', true],
    ['hockey/nhl', true],
    ['dead/league', false],
  ]) {
    await db.query(
      `insert into leagues (provider, provider_key, slug, name, sport, active)
       values ('espn', $1, $1, $1, split_part($1,'/',1), $2)`,
      [key, active],
    );
  }
  // A team follow, chosen deliberately, that must survive all of this.
  await db.query(
    `insert into teams (provider, provider_key, league_id, slug, name, display_name)
     select 'espn', 'x/1', l.id, 'a-team', 'Team', 'A Team' from leagues l limit 1`,
  );
  await db.query(
    `insert into follows (user_id, subject_type, subject_id)
     select $1, 'team', t.id from teams t limit 1`,
    [user],
  );
}, 60_000);

const followAll = async () =>
  (
    await db.query(
      `insert into follows (user_id, subject_type, subject_id)
       select $1, 'league', l.id from leagues l where l.active
       on conflict do nothing
       returning subject_id`,
      [user],
    )
  ).rows.length;

const leagueFollows = async () =>
  (
    await db.query(
      `select count(*)::int as n from follows where user_id = $1 and subject_type = 'league'`,
      [user],
    )
  ).rows[0].n;

describe('following everything', () => {
  test('follows every active league, and only active ones', async () => {
    expect(await followAll()).toBe(3);
    expect(await leagueFollows()).toBe(3);
  });

  test('pressing it again adds nothing and reports nothing', async () => {
    // "Followed 359" on a second press would be a lie; on conflict do nothing
    // means the returning clause is empty, which is what the page reports.
    expect(await followAll()).toBe(0);
    expect(await leagueFollows()).toBe(3);
  });

  test('a league added later is picked up by the next press', async () => {
    await db.query(
      `insert into leagues (provider, provider_key, slug, name, sport, active)
       values ('espn','soccer/new','soccer-new','New','soccer', true)`,
    );
    expect(await followAll()).toBe(1);
    expect(await leagueFollows()).toBe(4);
  });

  test('unfollow-all clears leagues and leaves team follows alone', async () => {
    // The undo for "follow everything" is "stop following everything", not
    // "forget what I picked".
    const removed = (
      await db.query(
        `delete from follows where user_id = $1 and subject_type = 'league' returning subject_id`,
        [user],
      )
    ).rows.length;
    expect(removed).toBe(4);
    expect(await leagueFollows()).toBe(0);

    const teams = (
      await db.query(
        `select count(*)::int as n from follows where user_id = $1 and subject_type = 'team'`,
        [user],
      )
    ).rows[0].n;
    expect(teams).toBe(1);
  });
});

describe('the page states the size before the click', () => {
  test('the button is paired with a count of what it signs you up for', async () => {
    const src = await readFile(
      new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toContain('Follow everything!');
    // A button that quietly enrols someone in thousands of notifications is a
    // trap; the fixture count has to be on the page beside it.
    expect(src).toContain('games in the next fortnight');
    expect(src).toContain('/api/unfollow-all');
  });
});
