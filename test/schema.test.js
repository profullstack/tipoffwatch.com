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
