import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * "Unfollow all" on My games.
 *
 * The distinction this file exists to pin down: /api/unfollow-all, behind the
 * follow-everything button on /sports, deliberately spares team follows, because
 * the undo for "follow everything" is "stop following everything" and not "forget
 * what I picked". /api/unfollow-everything is the opposite by design -- it is
 * pressed while looking at the list it empties, so it takes the teams too. Both
 * behaviours are correct and each is a bug if it acquires the other's.
 *
 * The rest is the ordinary danger of a delete with a `where user_id`: that it must
 * not reach past the person who pressed it.
 */
let db;
let user;
let other;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const mkUser = async (email) =>
    (await db.query(`insert into users (email) values ($1) returning id`, [email])).rows[0].id;
  user = await mkUser('a@example.test');
  other = await mkUser('b@example.test');

  for (const key of ['baseball/mlb', 'football/nfl', 'hockey/nhl']) {
    await db.query(
      `insert into leagues (provider, provider_key, slug, name, sport, active)
       values ('espn', $1, $1, $1, split_part($1,'/',1), true)`,
      [key],
    );
  }
  for (const [slug, name] of [
    ['a-team', 'A Team'],
    ['b-team', 'B Team'],
  ]) {
    await db.query(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       select 'espn', $1, l.id, $1, $2, $2 from leagues l limit 1`,
      [slug, name],
    );
  }

  // Two leagues and two teams for our user; one of each for somebody else, whose
  // follows must be untouched by any of this.
  await db.query(
    `insert into follows (user_id, subject_type, subject_id)
     select $1, 'league', l.id from leagues l limit 2`,
    [user],
  );
  await db.query(
    `insert into follows (user_id, subject_type, subject_id)
     select $1, 'team', t.id from teams t`,
    [user],
  );
  await db.query(
    `insert into follows (user_id, subject_type, subject_id)
     select $1, 'league', l.id from leagues l limit 1`,
    [other],
  );
  await db.query(
    `insert into follows (user_id, subject_type, subject_id)
     select $1, 'team', t.id from teams t limit 1`,
    [other],
  );
}, 60_000);

/** The statement behind q.unfollowAll, and the tally the route reports from it. */
const unfollowEverything = async (who) => {
  const { rows } = await db.query(`delete from follows where user_id = $1 returning subject_type`, [
    who,
  ]);
  return {
    removed: rows.length,
    leagues: rows.filter((r) => r.subject_type === 'league').length,
    teams: rows.filter((r) => r.subject_type === 'team').length,
  };
};

const countFor = async (who) =>
  (await db.query(`select count(*)::int as n from follows where user_id = $1`, [who])).rows[0].n;

describe('unfollowing everything', () => {
  test('clears teams as well as leagues, and reports the breakdown', async () => {
    expect(await countFor(user)).toBe(4);

    const result = await unfollowEverything(user);
    expect(result).toEqual({ removed: 4, leagues: 2, teams: 2 });
    expect(await countFor(user)).toBe(0);
  });

  test('leaves every other account alone', async () => {
    expect(await countFor(other)).toBe(2);
  });

  test('a second press removes nothing rather than failing', async () => {
    expect(await unfollowEverything(user)).toEqual({ removed: 0, leagues: 0, teams: 0 });
  });
});

describe('the two clears stay different', () => {
  /**
   * The regression that would be invisible in the UI: if unfollowAll were ever
   * written as the leagues-only delete, My games would clear the leagues, leave
   * every team chip on the page, and look like a half-working button.
   */
  test('q.unfollowAll is not scoped to leagues, and unfollowAllLeagues still is', async () => {
    const src = await readFile(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
    const body = (name) => src.slice(src.indexOf(`export async function ${name}(`)).split('\n}')[0];

    expect(body('unfollowAll')).not.toContain("subject_type = 'league'");
    expect(body('unfollowAllLeagues')).toContain("subject_type = 'league'");
    // Both must stay scoped to one account.
    expect(body('unfollowAll')).toMatch(/user_id = \$\{userId\}/);
  });
});

describe('the control on the page', () => {
  test('My games offers it, names what goes, and asks first', async () => {
    const { Following } = await import('../apps/web/src/views/pages.jsx');
    const html = (
      await Following({
        user: { id: 'u', email: 'a@example.test' },
        events: [],
        follows: [
          { subject_type: 'team', subject_id: 1, label: 'A Team' },
          { subject_type: 'team', subject_id: 2, label: 'B Team' },
          { subject_type: 'league', subject_id: 3, label: 'NFL' },
        ],
        cleared: null,
        calendarUrl: 'https://tipoffwatch.com/calendar/me/tok.ics',
      }).toString()
    ).toString();

    expect(html).toContain('/api/unfollow-everything');
    expect(html).toContain('Unfollow all');
    // The breakdown is the point: /sports spares teams, so "all" here has to say
    // out loud that these ones do not survive.
    expect(html).toContain('2 teams and 1 league');
    expect(html).toContain('data-confirm');
  });

  test('nothing followed means nothing to clear', async () => {
    const { Following } = await import('../apps/web/src/views/pages.jsx');
    const html = (
      await Following({ user: { id: 'u' }, events: [], follows: [], cleared: null }).toString()
    ).toString();
    expect(html).not.toContain('/api/unfollow-everything');
  });

  test('the receipt says what was removed, not just that something was', async () => {
    const { Following } = await import('../apps/web/src/views/pages.jsx');
    const html = (
      await Following({
        user: { id: 'u' },
        events: [],
        follows: [],
        cleared: { removed: 4, teams: 2, leagues: 2 },
      }).toString()
    ).toString();
    expect(html).toContain('Unfollowed 4');
    expect(html).toContain('2 teams and 2 leagues');
  });
});
