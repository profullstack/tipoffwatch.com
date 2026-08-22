import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { ProfilePage } = await import('../apps/web/src/views/people.jsx');

/**
 * What a public profile publishes about what its owner follows.
 *
 * The page counted two things for months and named neither: "44 teams followed"
 * with no way to ask which 44, and no fixtures at all. These tests pin the two
 * sections that answer those, and the three ways they can go quietly wrong.
 *
 * Like following-flag.test.js, the SQL is lifted out of queries.js and run as
 * written rather than restated here, so an edit to the shipped query is what runs.
 */
let db;
let publicFollowsSql;
let upcomingSql;

/** Lift one query body out of queries.js, with its bindings turned into $n. */
const lift = (source, name, params) => {
  const at = source.indexOf(`export async function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  const open = source.indexOf('sql`', at);
  const close = source.indexOf('`;', open);
  expect(close).toBeGreaterThan(open);
  let text = source.slice(open + 4, close);
  // A regex per binding, not a string literal: the thing being replaced is a
  // template placeholder, and writing it as text trips the lint rule that hunts
  // for accidental ones.
  params.forEach((p, i) => {
    text = text.replace(new RegExp(`\\$\\{${p}\\}`), `$${i + 1}`);
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
  publicFollowsSql = lift(source, 'publicFollows', ['userId', 'limit']);
  upcomingSql = lift(source, 'upcomingForProfile', ['userId', 'limit']);
}, 60_000);

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

describe('the teams a profile lists', () => {
  let userId;
  let leagueId;
  let teamId;

  beforeAll(async () => {
    userId = (
      await one(`insert into users (email, handle) values ('pf@example.test','pf') returning id`)
    ).id;
    leagueId = (
      await one(
        `insert into leagues (provider, provider_key, sport, slug, name)
         values ('espn','pf/league','basketball','pf-league','Zed League') returning id`,
      )
    ).id;
    teamId = (
      await one(
        `insert into teams (provider, provider_key, league_id, slug, name, display_name)
         values ('espn','pf/league/1',$1,'pf-team','Aces','Aces') returning id`,
        [leagueId],
      )
    ).id;
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'team',$2), ($1,'league',$3)`,
      [userId, teamId, leagueId],
    );
  });

  test('names them, rather than only counting them', async () => {
    const out = await rows(publicFollowsSql, [userId, 60]);
    expect(out.map((r) => r.label)).toEqual(['Aces', 'Zed League']);
  });

  test('carries the slug each chip has to link to', async () => {
    // Without this the chips render and go nowhere -- the failure looks like a
    // styling problem rather than a missing column.
    const out = await rows(publicFollowsSql, [userId, 60]);
    expect(out.find((r) => r.subject_type === 'team').slug).toBe('pf-team');
    expect(out.find((r) => r.subject_type === 'league').slug).toBe('pf-league');
  });

  test('puts teams before competitions, whatever they are called', async () => {
    // 'Aces' sorts before 'Zed League' alphabetically anyway, so alphabetical
    // ordering would pass the test above while burying a hand-picked club under
    // hundreds of leagues taken in one click. Rename the team to the end of the
    // alphabet and the team must still come first.
    await db.query(`update teams set display_name = 'Zzz Club' where id = $1`, [teamId]);
    const out = await rows(publicFollowsSql, [userId, 60]);
    expect(out.map((r) => r.subject_type)).toEqual(['team', 'league']);
    await db.query(`update teams set display_name = 'Aces' where id = $1`, [teamId]);
  });

  test('caps the list, so "follow everything" does not print the catalogue', async () => {
    const out = await rows(publicFollowsSql, [userId, 1]);
    expect(out.length).toBe(1);
  });
});

describe('the fixtures a profile lists', () => {
  let userId;
  let teamId;

  beforeAll(async () => {
    userId = (
      await one(`insert into users (email, handle) values ('pf2@example.test','pf2') returning id`)
    ).id;
    const leagueId = (
      await one(
        `insert into leagues (provider, provider_key, sport, slug, name)
         values ('espn','pf2/league','soccer','pf2-league','Sched League') returning id`,
      )
    ).id;
    teamId = (
      await one(
        `insert into teams (provider, provider_key, league_id, slug, name, display_name)
         values ('espn','pf2/league/1',$1,'pf2-team','Sched','Sched') returning id`,
        [leagueId],
      )
    ).id;
    const away = (
      await one(
        `insert into teams (provider, provider_key, league_id, slug, name, display_name)
         values ('espn','pf2/league/2',$1,'pf2-away','Away','Away') returning id`,
        [leagueId],
      )
    ).id;
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1,'team',$2)`,
      [userId, teamId],
    );
    const mkEvent = (key, when) =>
      db.query(
        `insert into events (provider, provider_key, league_id, home_team_id, away_team_id, name, starts_at, state)
         values ('espn',$1,$2,$3,$4,'Sched vs Away', now() + $5::interval, 'pre')`,
        [key, leagueId, teamId, away, when],
      );
    await mkEvent('pf2/past', '-2 days');
    await mkEvent('pf2/soon', '3 hours');
    await mkEvent('pf2/later', '5 days');
  });

  test('shows what is coming, soonest first', async () => {
    const out = await rows(upcomingSql, [userId, 10]);
    expect(out.map((e) => e.provider_key)).toEqual(['pf2/soon', 'pf2/later']);
  });

  test("never stars a stranger's fixtures as the viewer's own", async () => {
    // upcomingForUser stamps every row following:true, which EventRow draws as a
    // star titled "You follow one of these teams". Reused here that would tell
    // every visitor they follow whatever the profile's owner follows.
    const out = await rows(upcomingSql, [userId, 10]);
    expect(out.every((e) => e.following === false)).toBe(true);
  });

  test('carries the names the row prints', async () => {
    const [first] = await rows(upcomingSql, [userId, 10]);
    expect(first.home_name).toBe('Sched');
    expect(first.away_name).toBe('Away');
    expect(first.league_name).toBe('Sched League');
  });
});

describe('the profile page itself', () => {
  const html = async (props) =>
    (
      await ProfilePage({
        user: null,
        profile: { id: 1, handle: 'pf', display_name: null, bio: null, profile_public: true },
        counts: { followers: 0, following: 0, teams: 2 },
        followers: [],
        following: [],
        isFollowing: false,
        isSelf: false,
        ...props,
      }).toString()
    ).toString();

  const follows = [
    { subject_type: 'team', subject_id: 1, label: 'Aces', slug: 'pf-team' },
    { subject_type: 'league', subject_id: 2, label: 'Zed League', slug: 'pf-league' },
  ];

  test('renders the chips it was handed', async () => {
    // The bug this guards is the one following-flag.test.js was written for: the
    // route fetches the data correctly and never passes it to the view, which
    // looks fine in a screenshot and ships an empty section.
    const out = await html({ follows });
    expect(out).toContain('Aces');
    expect(out).toContain('Zed League');
  });

  test('links a team to its team page and a competition to its league page', async () => {
    const out = await html({ follows });
    expect(out).toContain('href="/teams/pf-team"');
    expect(out).toContain('href="/leagues/pf-league"');
  });

  test("offers no unfollow control on somebody else's page", async () => {
    // The chips on /following are unfollow forms. Copying them here would post a
    // delete for a row belonging to whoever is being read.
    const out = await html({ follows });
    expect(out).not.toContain('/api/unfollow');
  });

  test('says how many are not shown when the list is capped', async () => {
    const out = await html({ follows, counts: { followers: 0, following: 0, teams: 44 } });
    expect(out).toContain('Showing 2 of 44');
  });

  test('claims nothing extra when the list is whole', async () => {
    const out = await html({ follows, counts: { followers: 0, following: 0, teams: 2 } });
    expect(out).not.toContain('Showing');
  });

  test('renders the fixtures it was handed', async () => {
    const out = await html({
      follows,
      upcoming: [
        {
          id: 7,
          state: 'pre',
          starts_at: new Date('2030-01-01T00:00:00Z'),
          name: 'Aces vs Zed',
          home_name: 'Aces',
          away_name: 'Zed',
          league_name: 'Zed League',
          sport: 'basketball',
        },
      ],
    });
    expect(out).toContain('href="/events/7"');
  });

  test('has both headings even when there is nothing to put under them', async () => {
    const out = await html({});
    expect(out).toContain('Teams &amp; competitions');
    expect(out).toContain('Coming up');
  });
});
