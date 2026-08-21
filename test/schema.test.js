import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * The migrations and the scale-critical queries, run against a real Postgres 18
 * in-process. No server, no Docker -- so this runs in CI and on a laptop alike.
 */
let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  // Booting a WASM Postgres and running every migration overruns the 5s default on a
  // loaded machine; the work is legitimately slow rather than hung.
}, 60_000);

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

describe('migrations', () => {
  test('every table the app queries exists', async () => {
    const { rows } = await db.query(
      `select table_name from information_schema.tables where table_schema='public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'users',
      'login_tokens',
      'sessions',
      'passkeys',
      'leagues',
      'teams',
      'events',
      'follows',
      'reminder_prefs',
      'push_subscriptions',
      'reminder_deliveries',
      'stream_offers',
      'payments',
      'entitlements',
    ]) {
      expect(names).toContain(t);
    }
  });

  test('there is no password column anywhere', async () => {
    const { rows } = await db.query(
      `select table_name, column_name from information_schema.columns
       where table_schema='public' and column_name ilike '%password%'`,
    );
    expect(rows).toEqual([]);
  });
});

describe('reminder fan-out', () => {
  let eventId;
  let userIds;

  beforeAll(async () => {
    const league = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','soccer/eng.1','soccer','soccer-eng-1','Premier League') returning id`,
    );
    const home = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','soccer/1',$1,'ars','Arsenal','Arsenal') returning id`,
      [league.id],
    );
    const away = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','soccer/2',$1,'cov','Coventry','Coventry City') returning id`,
      [league.id],
    );
    const ev = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id, away_team_id)
       values ('espn','soccer/eng.1/1',$1, now() + interval '61 minutes','Arsenal v Coventry',$2,$3)
       returning id`,
      [league.id, home.id, away.id],
    );
    eventId = ev.id;

    // 250 followers: some follow the home team, some the league, some both --
    // the fan-out must count each person exactly once.
    userIds = [];
    for (let i = 0; i < 250; i++) {
      const u = await one(`insert into users (email) values ($1) returning id`, [
        `u${i}@example.com`,
      ]);
      userIds.push(u.id);
      if (i % 2 === 0) {
        await db.query(
          `insert into follows (user_id, subject_type, subject_id) values ($1,'team',$2)`,
          [u.id, home.id],
        );
      }
      if (i % 3 === 0) {
        await db.query(
          `insert into follows (user_id, subject_type, subject_id) values ($1,'league',$2)`,
          [u.id, league.id],
        );
      }
    }
  }, 60_000);

  const page = (after, limit) =>
    db.query(
      `select distinct f.user_id from events e
       join follows f on (f.subject_type='league' and f.subject_id = e.league_id)
                      or (f.subject_type='team' and f.subject_id in (e.home_team_id, e.away_team_id))
       where e.id = $1 and f.user_id > $2::uuid
       order by f.user_id limit $3`,
      [eventId, after, limit],
    );

  test('keyset paging covers every follower exactly once', async () => {
    const expected = await db.query(
      `select count(distinct f.user_id)::int as n from events e
       join follows f on (f.subject_type='league' and f.subject_id = e.league_id)
                      or (f.subject_type='team' and f.subject_id in (e.home_team_id, e.away_team_id))
       where e.id = $1`,
      [eventId],
    );
    const total = expected.rows[0].n;
    expect(total).toBeGreaterThan(150);

    let after = '00000000-0000-0000-0000-000000000000';
    const seen = new Set();
    let pages = 0;
    for (;;) {
      const { rows } = await page(after, 50);
      if (rows.length === 0) break;
      for (const r of rows) {
        // A duplicate here is the bug OFFSET paging would have introduced.
        expect(seen.has(r.user_id)).toBe(false);
        seen.add(r.user_id);
      }
      after = rows[rows.length - 1].user_id;
      pages++;
      if (rows.length < 50) break;
    }
    expect(seen.size).toBe(total);
    expect(pages).toBeGreaterThan(1);
  });

  test('a person following both the team and the league is notified once', async () => {
    const { rows } = await page('00000000-0000-0000-0000-000000000000', 1000);
    expect(new Set(rows.map((r) => r.user_id)).size).toBe(rows.length);
  });

  const claimFor = (uid) =>
    db.query(
      `insert into reminder_deliveries (event_id, user_id, offset_minutes, channel)
       values ($1,$2,60,'webpush')
       on conflict (event_id, user_id, offset_minutes, channel) do update
         set status = 'sent', sent_at = now()
         where reminder_deliveries.status = 'failed'
       returning user_id`,
      [eventId, uid],
    );

  test('claiming a delivery twice sends once', async () => {
    const uid = userIds[0];
    expect((await claimFor(uid)).rows.length).toBe(1);
    // The retry -- BullMQ redelivering the same batch -- must win nothing.
    expect((await claimFor(uid)).rows.length).toBe(0);
  });

  test('a failed delivery can be re-claimed, a sent one cannot', async () => {
    const uid = userIds[1];
    expect((await claimFor(uid)).rows.length).toBe(1);

    // The send blew up, so the row is marked failed and the job will be retried.
    await db.query(
      `update reminder_deliveries set status = 'failed'
       where event_id = $1 and user_id = $2 and offset_minutes = 60 and channel = 'webpush'`,
      [eventId, uid],
    );

    // Without the do-update clause this returns nothing and the reminder is lost
    // for good on the first transient push error.
    expect((await claimFor(uid)).rows.length).toBe(1);

    // And now that it succeeded, it is closed again.
    expect((await claimFor(uid)).rows.length).toBe(0);
  });

  test('the due window opens when the threshold is crossed, not before', async () => {
    const mk = async (minutesAway, key) => {
      const l = await one(`select id from leagues where slug = 'soccer-eng-1'`);
      const r = await one(
        `insert into events (provider, provider_key, league_id, starts_at, name)
         values ('espn',$1,$2, now() + ($3 * interval '1 minute'),'W') returning id`,
        [key, l.id, minutesAway],
      );
      return r.id;
    };

    const due = async (offset) =>
      (
        await db.query(
          `select e.id from events e
           where e.state = 'pre'
             and e.starts_at - ($1 * interval '1 minute') <= now()
             and e.starts_at - ($1 * interval '1 minute') > now() - (300 * interval '1 second')`,
          [offset],
        )
      ).rows.map((r) => r.id);

    // 61 minutes away: the 60-minute threshold is still a minute in the future.
    const early = await mk(61, 'w/early');
    expect(await due(60)).not.toContain(early);

    // 59 minutes away: crossed a minute ago, and well inside the lookback.
    const ready = await mk(59, 'w/ready');
    expect(await due(60)).toContain(ready);

    // Its 1-minute reminder is still 58 minutes off.
    expect(await due(1)).not.toContain(ready);

    // Crossed 10 minutes ago: outside the lookback, so a backlogged worker drops it
    // rather than telling someone a game starts in an hour when it already has.
    const stale = await mk(45, 'w/stale');
    expect(await due(60)).not.toContain(stale);
  });
});

describe('stream offers', () => {
  test('capacity cannot be oversold', async () => {
    const u = await one(`insert into users (email) values ('seller@example.com') returning id`);
    const l = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','x/y','soccer','x-y','L') returning id`,
    );
    const e = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name)
       values ('espn','x/y/1',$1, now() + interval '1 day','G') returning id`,
      [l.id],
    );
    const o = await one(
      `insert into stream_offers (event_id, seller_user_id, provider_ref, price_cents, capacity)
       values ($1,$2,'ref',100,2) returning id`,
      [e.id, u.id],
    );

    const buy = () =>
      db.query(
        `update stream_offers set sold = sold + 1 where id = $1 and active and sold < capacity returning id`,
        [o.id],
      );

    expect((await buy()).rows.length).toBe(1);
    expect((await buy()).rows.length).toBe(1);
    // The third buyer must get nothing rather than a seat that does not exist.
    expect((await buy()).rows.length).toBe(0);

    const row = await one(`select sold, capacity from stream_offers where id = $1`, [o.id]);
    expect(row.sold).toBe(2);
  });

  test('a person cannot buy the same game twice', async () => {
    const u = await one(`insert into users (email) values ('buyer@example.com') returning id`);
    const l = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','a/b','soccer','a-b','L2') returning id`,
    );
    const e = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name)
       values ('espn','a/b/1',$1, now() + interval '1 day','G2') returning id`,
      [l.id],
    );
    const ins = () =>
      db.query(
        `insert into entitlements (user_id, event_id, expires_at)
         values ($1,$2, now() + interval '1 day')
         on conflict (user_id, event_id) do nothing returning id`,
        [u.id, e.id],
      );
    expect((await ins()).rows.length).toBe(1);
    expect((await ins()).rows.length).toBe(0);
  });
});

describe('team ↔ league membership', () => {
  test('a club in several competitions appears in every one of them', async () => {
    const l1 = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','soccer/eng.1b','soccer','eng-1b','Premier League') returning id`,
    );
    const l2 = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','soccer/eng.fa','soccer','eng-fa','FA Cup') returning id`,
    );
    const team = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','soccer/368',$1,'eng-1b-368','Everton','Everton') returning id`,
      [l1.id],
    );

    // Both competitions claim the club, in either order.
    for (const l of [l1, l2]) {
      await db.query(
        `insert into team_leagues (team_id, league_id) values ($1,$2) on conflict do nothing`,
        [team.id, l.id],
      );
    }

    const inLeague = async (leagueId) =>
      (
        await db.query(
          `select t.display_name from team_leagues tl
           join teams t on t.id = tl.team_id where tl.league_id = $1`,
          [leagueId],
        )
      ).rows.map((r) => r.display_name);

    // The bug: teams.league_id was a single FK, so the second competition's sweep
    // overwrote the first and the club vanished from its own league page.
    expect(await inLeague(l1.id)).toContain('Everton');
    expect(await inLeague(l2.id)).toContain('Everton');
  });

  test('re-linking the same pair is idempotent', async () => {
    const l = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','x/idem','soccer','x-idem','L') returning id`,
    );
    const t = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','x/idem-1',$1,'x-idem-1','T','T') returning id`,
      [l.id],
    );
    for (let i = 0; i < 3; i++) {
      await db.query(
        `insert into team_leagues (team_id, league_id) values ($1,$2) on conflict do nothing`,
        [t.id, l.id],
      );
    }
    const { rows } = await db.query(
      `select count(*)::int as n from team_leagues where team_id = $1 and league_id = $2`,
      [t.id, l.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('fixture ↔ team re-linking', () => {
  test('an upsert re-attaches teams to a fixture whose references were cleared', async () => {
    const l = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','football/nfl','football','football-nfl','NFL') returning id`,
    );
    const home = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','football/nfl/34',$1,'nfl-34','Texans','Houston Texans') returning id`,
      [l.id],
    );
    const away = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','football/nfl/13',$1,'nfl-13','Raiders','Las Vegas Raiders') returning id`,
      [l.id],
    );
    const ev = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id, away_team_id)
       values ('espn','football/nfl/999',$1, now() + interval '2 days','Raiders at Texans',$2,$3)
       returning id`,
      [l.id, home.id, away.id],
    );

    // What migration 0005 did when it rebuilt every team row.
    await db.query(`update events set home_team_id = null, away_team_id = null where id = $1`, [
      ev.id,
    ]);

    // The next sweep re-upserts the same fixture. Without home_team_id/away_team_id
    // in the ON CONFLICT set, this updated the name and time and left the references
    // null -- the list still rendered "Raiders at Texans" from the provider's title
    // string while every team page sat empty.
    await db.query(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id, away_team_id)
       values ('espn','football/nfl/999',$1, now() + interval '2 days','Raiders at Texans',$2,$3)
       on conflict (provider, provider_key) do update set
         name = excluded.name,
         home_team_id = coalesce(excluded.home_team_id, events.home_team_id),
         away_team_id = coalesce(excluded.away_team_id, events.away_team_id)`,
      [l.id, home.id, away.id],
    );

    const row = await one(`select home_team_id, away_team_id from events where id = $1`, [ev.id]);
    expect(row.home_team_id).toBe(home.id);
    expect(row.away_team_id).toBe(away.id);

    // And the team now reports its fixture instead of "no fixtures scheduled".
    const cnt = await one(
      `select count(*)::int as n from events
       where (home_team_id = $1 or away_team_id = $1) and starts_at > now()`,
      [home.id],
    );
    expect(cnt.n).toBe(1);
  });

  test('a provider omitting one side cannot wipe a reference already resolved', async () => {
    const l = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','racing/f1b','racing','racing-f1b','F1') returning id`,
    );
    const t = await one(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ('espn','racing/f1b/1',$1,'f1b-1','X','X') returning id`,
      [l.id],
    );
    const ev = await one(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id)
       values ('espn','racing/f1b/1',$1, now() + interval '1 day','GP',$2) returning id`,
      [l.id, t.id],
    );
    await db.query(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id)
       values ('espn','racing/f1b/1',$1, now() + interval '1 day','GP', null)
       on conflict (provider, provider_key) do update set
         home_team_id = coalesce(excluded.home_team_id, events.home_team_id)`,
      [l.id],
    );
    const row = await one(`select home_team_id from events where id = $1`, [ev.id]);
    expect(row.home_team_id).toBe(t.id);
  });
});

/**
 * Which fixtures the play poller picks up.
 *
 * Scoped to live games alone, this lost the end of every match: the poll runs every
 * two minutes, the final score and the flip to `post` land on the one-minute score
 * tick, and the event stopped matching before the last drive was ever fetched. The
 * predicate below is the one in eventsNeedingPlays -- the guard at the bottom of
 * this block fails if the two drift apart.
 */
describe('play log selection', () => {
  const DUE = `
    select e.id from events e
    where (
        (e.state = 'in'
          and (e.plays_synced_at is null
               or e.plays_synced_at < now() - ($1 * interval '1 second')))
        or
        (e.state = 'post'
          and e.starts_at > now() - interval '12 hours'
          and (e.plays_synced_at is null or e.plays_synced_at < e.updated_at))
      )`;

  let league;
  beforeAll(async () => {
    league = await one(
      `insert into leagues (provider, provider_key, sport, slug, name)
       values ('espn','football/nflp','football','football-nflp','NFL P') returning id`,
    );
  });

  /** One fixture, positioned in time and in sync state exactly as described. */
  const mk = async ({ key, state, startsHoursAgo, syncedSecondsAgo, updatedSecondsAgo = 3600 }) =>
    (
      await one(
        `insert into events (provider, provider_key, league_id, starts_at, name, state,
                             plays_synced_at, updated_at)
         values ('espn',$1,$2, now() - ($3 * interval '1 hour'),'G',$4,
                 case when $5::int is null then null else now() - ($5 * interval '1 second') end,
                 now() - ($6 * interval '1 second'))
         returning id`,
        [key, league.id, startsHoursAgo, state, syncedSecondsAgo, updatedSecondsAgo],
      )
    ).id;

  const due = async () => (await db.query(DUE, [120])).rows.map((r) => r.id);

  test('a live game is picked up once its log goes stale, and not before', async () => {
    const fresh = await mk({ key: 'a1', state: 'in', startsHoursAgo: 1, syncedSecondsAgo: 30 });
    const stale = await mk({ key: 'a2', state: 'in', startsHoursAgo: 1, syncedSecondsAgo: 300 });
    const never = await mk({ key: 'a3', state: 'in', startsHoursAgo: 1, syncedSecondsAgo: null });

    const ids = await due();
    expect(ids).not.toContain(fresh);
    expect(ids).toContain(stale);
    expect(ids).toContain(never);
  });

  test('a game that just ended gets one more read, then stops matching', async () => {
    // The score tick stamped updated_at when it wrote the final score, and that is
    // newer than our last play read -- so the last drive is still owed.
    const ended = await mk({
      key: 'b1',
      state: 'post',
      startsHoursAgo: 3,
      syncedSecondsAgo: 300,
      updatedSecondsAgo: 60,
    });
    expect(await due()).toContain(ended);

    // markPlaysSynced touches plays_synced_at and nothing else -- there is no
    // updated_at trigger on events -- so the catch-up read does not re-arm itself.
    await db.query(`update events set plays_synced_at = now() where id = $1`, [ended]);
    expect(await due()).not.toContain(ended);
  });

  test('a game finished long ago is not re-read', async () => {
    // Without the window, a backfill that restates old fixtures would pull a whole
    // season of 500KB summaries through a metered proxy.
    const old = await mk({
      key: 'b2',
      state: 'post',
      startsHoursAgo: 30,
      syncedSecondsAgo: null,
      updatedSecondsAgo: 60,
    });
    expect(await due()).not.toContain(old);
  });

  test('a fixture that has not started is never fetched', async () => {
    const upcoming = await mk({
      key: 'c1',
      state: 'pre',
      startsHoursAgo: -2,
      syncedSecondsAgo: null,
    });
    expect(await due()).not.toContain(upcoming);
  });

  test('the predicate under test is still the one the query uses', async () => {
    const src = await Bun.file(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    ).text();
    const normalise = (s) =>
      s
        .replace(/\$\d+|\$\{[^}]+\}/g, '?')
        .replace(/\s+/g, ' ')
        .trim();
    expect(normalise(src)).toContain(normalise(DUE.slice(DUE.indexOf('where'))));
  });
});
