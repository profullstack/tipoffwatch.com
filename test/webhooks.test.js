import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';
process.env.SITE_URL = 'https://tipoffwatch.test';

const { scanOnce, EVENT_TYPES } = await import('../packages/webhooks/src/scan.js');
const keys = await import('../packages/webhooks/src/apikeys.js');
const {
  pgPool,
  webhookOwner,
  webhooksHandler,
  createHub,
  postgresStore,
  schemaSql,
  verifyAndParse,
  Webhooks,
} = await import('../packages/webhooks/src/index.js');

/**
 * Customer webhooks (packages/webhooks).
 *
 * The scan runs on PGlite -- a real Postgres -- against the real migrations, and
 * the hub it feeds uses postgresStore on the same database, so what is tested is
 * the whole path: fixture state -> claim -> outbox row -> signed POST a receiver
 * can verify.
 */

const SITE = 'https://tipoffwatch.test';
const ROOT = new URL('../', import.meta.url).pathname;

let db;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

let user;
let other;
let league;
let home;
let away;
let sent;
let hub;

function makeHub() {
  sent = [];
  return new Webhooks({
    store: postgresStore(db),
    source: SITE,
    eventTypes: EVENT_TYPES,
    guard: { allowHttp: true, allowPrivate: true },
    fetchImpl: async (url, init) => {
      sent.push({ url: String(url), headers: new Headers(init.headers), body: String(init.body) });
      return new Response(null, { status: 204 });
    },
  });
}

const scan = (caps) =>
  scanOnce({
    db,
    siteUrl: SITE,
    emit: (o, t, d, opts) => hub.emit(o, t, d, opts),
    ...(caps ? { caps } : {}),
  });

let n = 0;
async function game({ state = 'pre', startsIn = '30 minutes', homeId, awayId, leagueId } = {}) {
  n++;
  return one(
    `insert into events (provider, provider_key, league_id, starts_at, name, state,
                         home_team_id, away_team_id, home_score, away_score)
     values ('espn', $1, $2, now() + $3::interval, $4, $5, $6, $7, $8, $9) returning id`,
    [
      `t/${n}`,
      leagueId ?? league.id,
      startsIn,
      `Away ${n} at Home ${n}`,
      state,
      homeId ?? null,
      awayId ?? null,
      state === 'pre' ? null : 2,
      state === 'pre' ? null : 1,
    ],
  );
}

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = `${ROOT}packages/db/migrations/`;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  user = await one(`insert into users (email) values ('fan@example.com') returning id`);
  other = await one(`insert into users (email) values ('other@example.com') returning id`);
  league = await one(
    `insert into leagues (provider, provider_key, sport, slug, name)
     values ('espn','football/whz','football','football-whz','WH League') returning id`,
  );
  const otherLeague = await one(
    `insert into leagues (provider, provider_key, sport, slug, name)
     values ('espn','football/whq','football','football-whq','Unfollowed League') returning id`,
  );
  league.other = otherLeague.id;
  home = await one(
    `insert into teams (provider, provider_key, league_id, slug, name, display_name)
     values ('espn','wh/1',$1,'wh-home','Home','Home Hawks') returning id`,
    [otherLeague.id],
  );
  away = await one(
    `insert into teams (provider, provider_key, league_id, slug, name, display_name)
     values ('espn','wh/2',$1,'wh-away','Away','Away Owls') returning id`,
    [otherLeague.id],
  );
  // The fan follows one TEAM (in a league they do not follow) and nothing else.
  await db.query(`insert into follows (user_id, subject_type, subject_id) values ($1,'team',$2)`, [
    user.id,
    home.id,
  ]);
  // The other account follows the whole first league, but has no webhook.
  await db.query(
    `insert into follows (user_id, subject_type, subject_id) values ($1,'league',$2)`,
    [other.id, league.id],
  );
  hub = makeHub();
}, 60_000);

describe('the migration', () => {
  test("carries the package's own pg DDL verbatim", async () => {
    const migration = await readFile(
      `${ROOT}packages/db/migrations/0041_customer_webhooks.sql`,
      'utf8',
    );
    const squash = (s) => s.replace(/\s+/g, ' ');
    for (const stmt of schemaSql('pg')) expect(squash(migration)).toContain(squash(stmt));
  });
});

describe('the scan', () => {
  let endpoint;
  let secret;

  test('finds nothing while nobody has an endpoint', async () => {
    await game({ homeId: home.id, awayId: away.id, leagueId: league.other });
    expect(await scan()).toEqual({
      'game.starting': 0,
      'game.started': 0,
      'game.final': 0,
      'line.moved': 0,
    });
    // And claims nothing, so the game is still announceable once someone subscribes.
    expect((await one(`select count(*)::int as n from webhook_marks`)).n).toBe(0);
  });

  test('game.starting goes to the follower, signed, and only once', async () => {
    ({ endpoint, secret } = await hub.createEndpoint(String(user.id), {
      url: 'http://receiver.test/hook',
    }));
    const queued = await scan();
    expect(queued['game.starting']).toBe(1);
    expect(await scan()).toEqual({
      'game.starting': 0,
      'game.started': 0,
      'game.final': 0,
      'line.moved': 0,
    });

    await hub.drain();
    expect(sent).toHaveLength(1);
    const r = verifyAndParse({ headers: sent[0].headers, body: sent[0].body, secret });
    expect(r.ok).toBe(true);
    expect(r.event.type).toBe('game.starting');
    expect(r.event.source).toBe(SITE);
    expect(r.event.data.game.home).toEqual({ name: 'Home Hawks', slug: 'wh-home', score: null });
    expect(r.event.data.game.url).toMatch(/^https:\/\/tipoffwatch\.test\/events\/\d+$/);
    expect(r.event.subject).toBe(`game:${r.event.data.game.id}`);
    expect(r.event.id).toBe(`game.starting:${r.event.data.game.id}`);
  });

  test('game.started and game.final carry the state and score', async () => {
    sent.length = 0;
    const g = await game({ state: 'in', startsIn: '-20 minutes', homeId: home.id });
    expect((await scan())['game.started']).toBe(1);
    await db.query(`update events set state = 'post', updated_at = now() where id = $1`, [g.id]);
    expect((await scan())['game.final']).toBe(1);
    await hub.drain();
    // Both were due in the same millisecond, so the outbox may send either first.
    const events = sent.map((s) => JSON.parse(s.body));
    expect(events.map((e) => e.type).sort()).toEqual(['game.final', 'game.started']);
    const final = events.find((e) => e.type === 'game.final');
    expect(final.data.game.state).toBe('post');
    expect(final.data.game.home.score).toBe(2);
  });

  test('a game nobody with a webhook follows is not announced', async () => {
    sent.length = 0;
    // In the league `other` follows -- but `other` has no endpoint.
    await game({ state: 'in', startsIn: '-5 minutes' });
    expect((await scan())['game.started']).toBe(0);
  });

  test('line.moved needs a previous reading, and carries both', async () => {
    sent.length = 0;
    const g = await game({ startsIn: '3 days', homeId: home.id });
    const snap = (spread, ago) =>
      db.query(
        `insert into event_odds_snapshots (event_id, observed_at, provider, details, spread, over_under, captured_state)
         values ($1, now() - $3::interval, 'DraftKings', $2, $4, 44.5, 'pre')`,
        [g.id, `HOME ${spread}`, ago, spread],
      );
    await snap(-3.5, '10 minutes');
    expect((await scan())['line.moved']).toBe(0); // where the market opened is not a move
    await snap(-4.5, '1 minute');
    expect((await scan())['line.moved']).toBe(1);
    await hub.drain();
    const ev = JSON.parse(sent.at(-1).body);
    expect(ev.type).toBe('line.moved');
    expect(ev.data.line.spread).toBe(-4.5);
    expect(ev.data.previous.spread).toBe(-3.5);
    expect(ev.data.line.over_under).toBe(44.5);
  });

  test("an endpoint's event filter is honoured", async () => {
    await hub.updateEndpoint(String(user.id), endpoint.id, { events: ['game.final'] });
    sent.length = 0;
    await game({ state: 'in', startsIn: '-1 minutes', homeId: home.id });
    expect((await scan())['game.started']).toBe(0);
    await hub.updateEndpoint(String(user.id), endpoint.id, { events: ['*'] });
  });

  test('line.moved is capped per account per hour', async () => {
    const g = await game({ startsIn: '5 days', homeId: home.id });
    for (const [spread, ago] of [
      [1, '20 minutes'],
      [2, '15 minutes'],
      [3, '10 minutes'],
      [4, '5 minutes'],
    ]) {
      await db.query(
        `insert into event_odds_snapshots (event_id, observed_at, spread, captured_state)
         values ($1, now() - $2::interval, $3, 'pre')`,
        [g.id, ago, spread],
      );
    }
    // Three moves; the line.moved count this hour is already 1 from the test above.
    expect((await scan({ 'line.moved': 2 }))['line.moved']).toBe(1);
  });
});

describe('API keys', () => {
  test('made, found, replaced and revoked; only the hash is stored', async () => {
    const key = await keys.createApiKey(db, user.id);
    expect(key).toStartWith('tok_');
    expect(await keys.userIdForApiKey(db, key)).toBe(String(user.id));
    const stored = await one(`select encode(key_hash, 'hex') as h, hint from api_keys`);
    expect(stored.h).not.toContain(key.slice(4));
    expect(stored.hint).toBe(key.slice(-4));
    expect((await keys.apiKeyInfo(db, user.id)).last_used_at).not.toBeNull();

    const next = await keys.createApiKey(db, user.id);
    expect(await keys.userIdForApiKey(db, key)).toBeNull();
    expect(await keys.userIdForApiKey(db, next)).toBe(String(user.id));
    await keys.revokeApiKey(db, user.id);
    expect(await keys.userIdForApiKey(db, next)).toBeNull();
    expect(await keys.userIdForApiKey(db, 'not-a-key')).toBeNull();
  });
});

describe('who is asking', () => {
  const lookup = async (k) => (k === 'tok_good' ? 'u-key' : null);
  const req = (method, headers = {}) => new Request(`${SITE}/api/v1/webhooks`, { method, headers });
  const me = { id: 'u-session' };

  test('a bearer key wins, and a bad one is nobody', async () => {
    expect(
      await webhookOwner(req('POST', { authorization: 'Bearer tok_good' }), me, {
        site: SITE,
        lookup,
      }),
    ).toBe('u-key');
    expect(
      await webhookOwner(req('GET', { authorization: 'Bearer tok_bad' }), me, {
        site: SITE,
        lookup,
      }),
    ).toBeNull();
  });

  test('a session reads, and writes only from this origin', async () => {
    expect(await webhookOwner(req('GET'), me, { site: SITE, lookup })).toBe('u-session');
    expect(await webhookOwner(req('POST'), me, { site: SITE, lookup })).toBeNull();
    expect(
      await webhookOwner(req('POST', { origin: 'https://evil.test' }), me, { site: SITE, lookup }),
    ).toBeNull();
    expect(await webhookOwner(req('POST', { origin: SITE }), me, { site: SITE, lookup })).toBe(
      'u-session',
    );
    expect(await webhookOwner(req('GET'), null, { site: SITE, lookup })).toBeNull();
  });

  test('the API answers 401 with nobody, and serves the owner otherwise', async () => {
    const h = makeHub();
    const anon = await webhooksHandler(null, h)(req('GET'));
    expect(anon.status).toBe(401);
    const res = await webhooksHandler(String(user.id), h)(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event_types).toEqual(EVENT_TYPES);
  });
});

describe('pgPool: Bun.SQL as a pg-style pool', () => {
  test('maps query(text, params) onto unsafe(text, params) and returns plain rows', async () => {
    const calls = [];
    const fake = {
      unsafe: async (text, params) => {
        calls.push([text, params]);
        const rows = [{ a: 1 }];
        rows.count = 1; // Bun's result carries extra fields
        return rows;
      },
    };
    const r = await pgPool(fake).query('select $1', [7]);
    expect(calls).toEqual([['select $1', [7]]]);
    expect(r.rows).toEqual([{ a: 1 }]);
    expect(Array.isArray(r.rows)).toBe(true);
    expect(Object.keys(r.rows)).toEqual(['0']);
  });

  test('scan.js never binds a JSON list as $n::jsonb (Bun.SQL sends a string scalar)', async () => {
    const src = await readFile(`${ROOT}packages/webhooks/src/scan.js`, 'utf8');
    expect(src.match(/\$\d::jsonb/g)).toBeNull();
    expect(src).toContain('::text::jsonb');
  });

  // Against a real server through Bun.SQL when one is given, e.g.
  // TEST_PG_URL=postgres://postgres:x@127.0.0.1:55441/postgres bun test test/webhooks.test.js
  const url = process.env.TEST_PG_URL;
  test.skipIf(!url)('round-trips the whole store on a real Postgres via Bun.SQL', async () => {
    const { SQL } = await import('bun');
    const real = new SQL(url);
    try {
      // The list-as-JSON idiom scan.js relies on, through the real driver.
      const { rows: listed } = await pgPool(real).query(
        'select (jsonb_array_elements_text($1::text::jsonb))::bigint as id',
        [JSON.stringify(['7', '9'])],
      );
      expect(listed.map((r) => Number(r.id))).toEqual([7, 9]);
      const prefix = `t${Date.now()}_`;
      for (const s of schemaSql('pg', prefix)) await real.unsafe(s);
      const bodies = [];
      const h = createHub({
        store: postgresStore(pgPool(real), { prefix }),
        guard: { allowHttp: true, allowPrivate: true },
        fetchImpl: async (_u, init) => {
          bodies.push(init);
          return new Response(null, { status: 204 });
        },
      });
      const { endpoint, secret } = await h.createEndpoint('owner-1', {
        url: 'http://receiver.test/x',
        events: ['game.*'],
      });
      expect(endpoint.created_at).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect((await h.listEndpoints('owner-1')).map((e) => e.id)).toEqual([endpoint.id]);
      expect((await h.emit('owner-1', 'game.final', { x: 1 })).queued).toBe(1);
      expect((await h.emit('owner-1', 'line.moved', { x: 1 })).queued).toBe(0);
      expect(await h.drain()).toBe(1);
      expect(
        verifyAndParse({ headers: new Headers(bodies[0].headers), body: bodies[0].body, secret })
          .ok,
      ).toBe(true);
      const [d] = await h.deliveries('owner-1');
      expect(d.status).toBe('delivered');
      expect((await h.rotateSecret('owner-1', endpoint.id)).secret).toStartWith('whsec_');
      await h.deleteEndpoint('owner-1', endpoint.id);
      for (const t of ['webhook_deliveries', 'webhook_endpoints'])
        await real.unsafe(`drop table ${prefix}${t}`);
    } finally {
      await real.end();
    }
  });
});
