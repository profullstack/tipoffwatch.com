import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const m = await import('../packages/sports/src/nichedbsports.js');
const sportsdb = await import('../packages/sports/src/sportsdb.js');

/*
 * The two kinds that made the mirror lossy: `plays` (the play-by-play and the
 * box score, one item per fixture) and `broadcast` (TheSportsDB's TV listings,
 * fetched by nichedb instead of here). The items are shaped as nichedb's
 * espn-plays and sportsdb-tv adapters emit them and its itemOut serialises them.
 * The store and the http client are handed in, as in nichedb-sports.test.js, so
 * every write and every request is asserted without a database or the network.
 */

const NOW = Date.parse('2026-09-13T22:10:00.000Z');
const HOUR = 3_600_000;

/* ------------------------------------------------------------------ items -- */

const play = (id, over = {}) => ({
  id: String(id),
  sequence: Number(id),
  text: `Play ${id}`,
  period: 1,
  periodLabel: '13:43 · 1st',
  clock: '13:43',
  homeScore: 0,
  awayScore: 0,
  scoring: false,
  type: 'Rush',
  team: 'home',
  teamId: '7',
  ...over,
});

const recap = {
  linescores: {
    labels: ['1', '2', '3', '4'],
    away: ['7', '3', '14', '0'],
    home: ['0', '10', '7', '3'],
  },
  teamStats: [{ group: null, label: 'Total Yards', home: '401', away: '312' }],
  leaders: [
    { side: 'home', team: 'DEN', category: 'PASS', name: 'B. Nix', line: '18/27, 241 YDS' },
  ],
  officials: ['C. Blakeman'],
  duration: '3:12',
  attendance: 76125,
  article: {
    headline: 'Broncos hold off Patriots',
    summary: 'DENVER --',
    source: 'AP',
    publishedAt: null,
  },
  odds: { provider: 'DraftKings', details: 'DEN -3.5', spread: -3.5, capturedState: 'post' },
};

/** The item nichedb writes for a game in progress: the tail of the log, no recap. */
const livePlays = (over = {}) => ({
  id: 3700001,
  collection: 'sports',
  source: 'espn-plays',
  adapter: 'espn-plays',
  kind: 'plays',
  external_id: 'espn:plays:football/nfl/401772510',
  updated_at: '2026-09-13T22:08:00.000Z',
  title: 'New England Patriots at Denver Broncos',
  summary: 'Play 3',
  url: 'https://www.espn.com/nfl/game/_/gameId/401772510',
  image_url: 'https://a.espncdn.com/i/teamlogos/nfl/500/den.png',
  published_at: '2026-09-13T20:25:00.000Z',
  time_known: true,
  precision: 'minute',
  tags: [
    'plays',
    'football',
    'league:football-nfl',
    'state:in',
    'fixture:espn:fixture:football/nfl/401772510',
  ],
  data: {
    provider: 'espn',
    sport: 'football',
    fixtureExternalId: 'espn:fixture:football/nfl/401772510',
    fixtureKey: 'football/nfl/401772510',
    eventId: '401772510',
    league: {
      slug: 'football-nfl',
      key: 'football/nfl',
      name: 'NFL',
      abbreviation: 'NFL',
      region: null,
    },
    home: { id: '7', name: 'Denver Broncos', score: 10 },
    away: { id: '17', name: 'New England Patriots', score: 7 },
    state: 'in',
    statusDetail: '2:00 - 2nd',
    playsSupported: true,
    boxscoreSupported: true,
    plays: [play(1), play(2, { scoring: true, homeScore: 7, type: 'Passing Touchdown' }), play(3)],
    playsTotal: 3,
    playsTruncated: false,
    recap: null,
    final: false,
    fetchedAt: '2026-09-13T22:08:00.000Z',
    ...over,
  },
  first_seen_at: '2026-09-13T20:30:00.000Z',
  enrichment: {},
  page: 'https://nichedb.dev/i/3700001',
});

/** The same item after the whistle: the whole log, the box score, final. */
const finalPlays = () =>
  livePlays({
    state: 'post',
    statusDetail: 'Final',
    plays: [
      play(1),
      play(2, { scoring: true, homeScore: 7 }),
      play(3),
      play(4),
      play(5, { period: 4, periodLabel: '0:00 · 4th' }),
    ],
    playsTotal: 5,
    recap,
    final: true,
    fetchedAt: '2026-09-13T23:40:00.000Z',
  });

/** One TheSportsDB TV row, as nichedb's sportsdb-tv adapter emits it. */
const broadcast = (id, over = {}) => ({
  id,
  collection: 'sports',
  source: 'sportsdb-tv',
  adapter: 'sportsdb-tv',
  kind: 'broadcast',
  external_id: `sportsdb:tv:2130${id}:seven-queensland:2026-09-13`,
  updated_at: '2026-09-13T06:00:00.000Z',
  title: 'Collingwood Football Club vs Brisbane Lions',
  summary: '7 Queensland',
  url: null,
  image_url: null,
  published_at: '2026-09-13T09:20:00.000Z',
  time_known: true,
  precision: 'minute',
  tags: [
    'broadcast',
    'australian-football',
    'date:2026-09-13',
    'country:australia',
    'channel:seven-queensland',
  ],
  data: {
    provider: 'thesportsdb',
    sport: 'Australian Football',
    league: 'AFL',
    home: 'Collingwood Football Club',
    away: 'Brisbane Lions',
    event: 'Collingwood Football Club vs Brisbane Lions',
    channel: '7 Queensland',
    country: 'Australia',
    starts_at: '2026-09-13T09:20:00.000Z',
    eventId: `2130${id}`,
    ...over,
  },
  first_seen_at: '2026-09-13T06:00:00.000Z',
  enrichment: {},
  page: `https://nichedb.dev/i/${id}`,
});

/* ------------------------------------------------------------------ fakes -- */

/**
 * The store, in memory, with the identities the real tables enforce: events on
 * (provider, provider_key), plays unique on (event_id, provider_play_id), the
 * recap stamped once by saveRecap and the final flag by markPlaysFinal.
 */
function fakeStore({ events = [], cursor = null } = {}) {
  const s = {
    events: new Map(
      events.map((e, i) => [
        `${e.provider}|${e.provider_key}`,
        {
          id: 100 + i,
          state: 'in',
          plays_final: false,
          recap_synced_at: null,
          recap: undefined,
          plays_synced_at: null,
          ...e,
        },
      ]),
    ),
    plays: new Map(),
    cursor,
    calls: [],
  };
  const byId = (id) => [...s.events.values()].find((e) => e.id === id);
  return {
    state: s,
    async leagueIndex() {
      return [];
    },
    async eventsByKeys(refs) {
      s.calls.push(['eventsByKeys', refs]);
      return refs
        .map((r) => s.events.get(`${r.provider}|${r.provider_key}`))
        .filter(Boolean)
        .map(({ id, provider, provider_key, state, plays_final, recap_synced_at }) => ({
          id,
          provider,
          provider_key,
          state,
          plays_final,
          recap_synced_at,
        }));
    },
    async insertPlays(rows) {
      s.calls.push(['insertPlays', rows]);
      const added = [];
      for (const r of rows) {
        const k = `${r.event_id}|${r.provider_play_id}`;
        if (s.plays.has(k)) continue;
        s.plays.set(k, { id: s.plays.size + 1, ...r });
        added.push({ id: s.plays.size });
      }
      return added;
    },
    async saveRecap(id, recap) {
      s.calls.push(['saveRecap', id, recap]);
      const e = byId(id);
      e.recap = recap;
      e.recap_synced_at = new Date(NOW);
      e.odds = e.odds ?? recap?.odds ?? null;
    },
    async markPlaysFinal(id) {
      s.calls.push(['markPlaysFinal', id]);
      Object.assign(byId(id), { plays_final: true, plays_synced_at: new Date(NOW) });
    },
    async markPlaysSynced(id) {
      s.calls.push(['markPlaysSynced', id]);
      byId(id).plays_synced_at = new Date(NOW);
    },
    async getCursor() {
      return s.cursor ? structuredClone(s.cursor) : null;
    },
    async setCursor(c) {
      s.cursor = structuredClone(c);
    },
  };
}

/**
 * nichedb's items endpoint over a fixed set of items per kind: keyset on id,
 * capped at 200, honouring `after`, and `tags` applied the way the real query
 * applies them -- every tag named must be on the item. `since` is recorded, not
 * applied, because what matters is that the right one was asked for.
 */
function fakeApi(byKind) {
  const requests = [];
  const http = async (url) => {
    const p = new URL(url).searchParams;
    const tags = (p.get('tags') ?? '').split(',').filter(Boolean);
    requests.push({
      kind: p.get('kind'),
      after: Number(p.get('after')) || 0,
      since: p.get('since'),
      from: p.get('from'),
      tags,
      limit: Number(p.get('limit')),
    });
    const after = Number(p.get('after')) || 0;
    const items = (byKind[p.get('kind')] ?? [])
      .filter((i) => i.id > after && tags.every((t) => i.tags.includes(t)))
      .sort((a, b) => a.id - b.id)
      .slice(0, 200);
    return { count: items.length, items };
  };
  return { http, requests };
}

const quiet = () => {};
const nfl = { provider: 'espn', provider_key: 'football/nfl/401772510' };
const opts = (store, api, over = {}) => ({
  store,
  http: api.http,
  log: quiet,
  now: NOW,
  base: 'http://x',
  ...over,
});

/* ---------------------------------------------------------------- mapping -- */

describe('mapPlays', () => {
  test('maps every play field onto the event_plays columns', () => {
    const out = m.mapPlays(livePlays());
    expect(out).toMatchObject({ ...nfl, final: false, recap: null });
    expect(out.plays).toHaveLength(3);
    expect(out.plays[1]).toEqual({
      provider_play_id: '2',
      sequence: 2,
      text: 'Play 2',
      away_score: 0,
      home_score: 7,
      scoring: true,
      period_number: 1,
      period_label: '13:43 · 1st',
      play_type: 'Passing Touchdown',
    });
  });

  test('a final item carries the recap and says so', () => {
    const out = m.mapPlays(finalPlays());
    expect(out.final).toBe(true);
    expect(out.recap).toEqual(recap);
    expect(out.plays).toHaveLength(5);
  });

  test('the state tag stands in for a missing final flag, and a live recap is never kept', () => {
    expect(m.mapPlays(livePlays({ final: undefined, state: 'post' })).final).toBe(true);
    expect(m.mapPlays(livePlays({ recap })).recap).toBeNull();
  });

  test('a play without an id or text cannot be stored, and a repeated id is one play', () => {
    const out = m.mapPlays(
      livePlays({
        plays: [play(1), play(1), { id: '', text: 'x' }, { id: '9', text: '' }, play(2)],
      }),
    );
    expect(out.plays.map((p) => p.provider_play_id)).toEqual(['1', '2']);
  });

  test('resolves the fixture from its external id, or from provider + key without one', () => {
    expect(m.fixtureRef(livePlays().data)).toEqual(nfl);
    expect(m.fixtureRef({ provider: 'espn', fixtureKey: 'football/nfl/1' })).toEqual({
      provider: 'espn',
      provider_key: 'football/nfl/1',
    });
    expect(m.fixtureRef({ fixtureExternalId: 'nonsense' })).toBeNull();
    expect(m.mapPlays({ kind: 'fixture', data: livePlays().data })).toBeNull();
  });
});

describe('mapBroadcast', () => {
  test('is the listing row the matcher reads, dated by the tag', () => {
    expect(m.mapBroadcast(broadcast(1))).toEqual({
      event: 'Collingwood Football Club vs Brisbane Lions',
      channel: '7 Queensland',
      country: 'Australia',
      sport: 'Australian Football',
      date: '2026-09-13',
    });
  });

  test('puts the sides back together when the title is missing, and drops a row with no channel', () => {
    expect(m.mapBroadcast(broadcast(1, { event: null })).event).toBe(
      'Collingwood Football Club vs Brisbane Lions',
    );
    expect(m.mapBroadcast(broadcast(1, { channel: '' }))).toBeNull();
  });
});

/* ------------------------------------------------------------------ plays -- */

describe('the plays tick under the mirror', () => {
  test('a live item appends the tail of the log, stamps the fixture, and sets the plays cursor', async () => {
    const store = fakeStore({ events: [nfl] });
    const api = fakeApi({ plays: [livePlays()] });
    const out = await m.syncPlays(opts(store, api));

    expect(out).toMatchObject({ playsItems: 1, plays: 3, recaps: 0, requests: 1 });
    // The first pass ever asks for the six hours nichedb itself carries.
    expect(api.requests).toEqual([
      expect.objectContaining({
        kind: 'plays',
        since: new Date(NOW - m.PLAYS_LOOKBACK_MS).toISOString(),
        from: null,
        after: 0,
        limit: 200,
      }),
    ]);
    const event = store.state.events.get('espn|football/nfl/401772510');
    expect(event.plays_synced_at).toEqual(new Date(NOW));
    expect(event.plays_final).toBe(false);
    expect(event.recap_synced_at).toBeNull();
    expect(store.state.calls.map((c) => c[0])).toEqual([
      'eventsByKeys',
      'insertPlays',
      'markPlaysSynced',
    ]);
    // Its own cursor, beside the fixtures one.
    expect(store.state.cursor.playsSince).toBe(new Date(NOW - m.OVERLAP_MS).toISOString());
    expect(store.state.cursor.since).toBeUndefined();
    expect(store.state.cursor.spend).toEqual({ hour: m.utcHour(NOW), calls: 1 });
  });

  test('the final item adds only the new plays, saves the recap once, and closes the fixture', async () => {
    const store = fakeStore({ events: [nfl] });
    await m.syncPlays(opts(store, fakeApi({ plays: [livePlays()] })));
    store.state.calls.length = 0;

    const later = NOW + HOUR;
    const api = fakeApi({ plays: [finalPlays()] });
    const out = await m.syncPlays(opts(store, api, { now: later }));

    expect(out).toMatchObject({ playsItems: 1, plays: 2, recaps: 1 });
    // Asked from where the last pass left off.
    expect(api.requests[0].since).toBe(new Date(NOW - m.OVERLAP_MS).toISOString());
    expect(store.state.plays.size).toBe(5);
    const event = store.state.events.get('espn|football/nfl/401772510');
    expect(event.plays_final).toBe(true);
    expect(event.recap).toEqual(recap);
    expect(event.recap_synced_at).not.toBeNull();
    // The closing line rides in with the recap, through saveRecap's coalesce.
    expect(event.odds).toEqual(recap.odds);
    expect(store.state.calls.map((c) => c[0])).toEqual([
      'eventsByKeys',
      'insertPlays',
      'saveRecap',
      'markPlaysFinal',
    ]);

    // The overlap re-reads the same final item next pass: nothing new, and the
    // recap is not written a second time.
    store.state.calls.length = 0;
    const again = await m.syncPlays(
      opts(store, fakeApi({ plays: [finalPlays()] }), { now: later + HOUR }),
    );
    expect(again).toMatchObject({ playsItems: 1, plays: 0, recaps: 0 });
    expect(store.state.plays.size).toBe(5);
    expect(store.state.calls.map((c) => c[0])).toEqual([
      'eventsByKeys',
      'insertPlays',
      'markPlaysFinal',
    ]);
  });

  test('a final item with no box score still closes the recap queue, once', async () => {
    const store = fakeStore({ events: [nfl] });
    const item = finalPlays();
    item.data.recap = null;
    item.data.plays = [];
    const out = await m.syncPlays(opts(store, fakeApi({ plays: [item] })));
    expect(out).toMatchObject({ playsItems: 1, plays: 0, recaps: 0 });
    const [, id, saved] = store.state.calls.find((c) => c[0] === 'saveRecap');
    expect(id).toBe(100);
    expect(saved).toBeNull();
    expect(store.state.events.get('espn|football/nfl/401772510').recap_synced_at).not.toBeNull();
  });

  test('an item whose fixture is not mirrored yet is counted and nothing is written', async () => {
    const store = fakeStore();
    const out = await m.syncPlays(opts(store, fakeApi({ plays: [livePlays()] })));
    expect(out).toMatchObject({ playsItems: 0, plays: 0, playsOrphans: 1 });
    expect(store.state.calls.map((c) => c[0])).toEqual(['eventsByKeys']);
    // The cursor still moves: a live item comes round again in two minutes.
    expect(store.state.cursor.playsSince).toBe(new Date(NOW - m.OVERLAP_MS).toISOString());
  });

  test('a quiet tick is one request and moves the cursor', async () => {
    const store = fakeStore({
      cursor: { since: '2026-09-13T22:00:00.000Z', playsSince: '2026-09-13T21:00:00.000Z' },
    });
    const api = fakeApi({ plays: [] });
    const out = await m.syncPlays(opts(store, api));
    expect(out.requests).toBe(1);
    expect(api.requests[0]).toMatchObject({ kind: 'plays', since: '2026-09-13T21:00:00.000Z' });
    expect(store.state.cursor.playsSince).toBe(new Date(NOW - m.OVERLAP_MS).toISOString());
    // The fixtures cursor is not this walk's to move.
    expect(store.state.cursor.since).toBe('2026-09-13T22:00:00.000Z');
  });

  test('shares the hourly budget with the fixture walks', async () => {
    const store = fakeStore({
      events: [nfl],
      cursor: { since: '2026-09-13T22:00:00.000Z', spend: { hour: m.utcHour(NOW), calls: 480 } },
    });
    const out = await m.syncPlays(opts(store, fakeApi({ plays: [livePlays()] })));
    expect(out).toMatchObject({ requests: 0, exhausted: true, spent: '480/480' });
    expect(store.state.cursor.pending).toMatchObject({ id: 'plays:since', kind: 'plays' });
    expect(store.state.cursor.playsSince).toBeUndefined();
  });
});

/* ------------------------------------------------------------- broadcasts -- */

const afl = {
  id: 455,
  starts_at: new Date('2026-09-13T09:20:00.000Z'),
  sport: 'australian-football',
  home_name: 'Collingwood Magpies',
  away_name: 'Brisbane Lions',
};

describe('the broadcast fill under the mirror', () => {
  test('reads each day the fixtures fall on, once, and matches by team name', async () => {
    const store = fakeStore();
    const api = fakeApi({
      broadcast: [
        broadcast(5001),
        broadcast(5002, { channel: 'Fox Footy', country: 'Australia' }),
        broadcast(5003, {
          event: 'Carlton vs Fremantle',
          home: 'Carlton',
          away: 'Fremantle',
          channel: 'Kayo',
        }),
        // The day before, where a late kickoff can land on the other provider's calendar.
        {
          ...broadcast(5004, { channel: 'Watch AFL', country: 'International' }),
          tags: ['broadcast', 'date:2026-09-12'],
        },
      ],
    });
    const out = await m.syncBroadcasts({ events: [afl, { ...afl, id: 456 }], ...opts(store, api) });

    // Two fixtures, one day: two requests, day before and day of, not four.
    expect(api.requests.map((r) => [r.kind, r.tags, r.since, r.from])).toEqual([
      ['broadcast', ['broadcast', 'date:2026-09-12'], null, null],
      ['broadcast', ['broadcast', 'date:2026-09-13'], null, null],
    ]);
    expect(out).toMatchObject({ requests: 2, listings: 4, days: 2 });
    expect(out.updates).toEqual([
      {
        id: 455,
        broadcast: '7 Queensland, Fox Footy',
        country: 'Australia',
        markets: [
          { country: 'Australia', channels: ['7 Queensland', 'Fox Footy'] },
          { country: 'International', channels: ['Watch AFL'] },
        ],
      },
      expect.objectContaining({ id: 456, broadcast: '7 Queensland, Fox Footy' }),
    ]);
    // Nothing about the fixtures cursor is touched; only the spend is recorded.
    expect(store.state.cursor.since).toBeUndefined();
    expect(store.state.cursor.pending).toBeNull();
    expect(store.state.cursor.spend).toEqual({ hour: m.utcHour(NOW), calls: 2 });
  });

  test('a fixture with no listing gets no guess', async () => {
    const store = fakeStore();
    const api = fakeApi({
      broadcast: [broadcast(5003, { event: 'Carlton vs Fremantle', channel: 'Kayo' })],
    });
    const out = await m.syncBroadcasts({ events: [afl], ...opts(store, api) });
    expect(out.updates).toEqual([]);
    expect(out.requests).toBe(2);
  });

  test('nothing to fill is no request at all', async () => {
    const api = fakeApi({ broadcast: [broadcast(5001)] });
    const out = await m.syncBroadcasts({ events: [], ...opts(fakeStore(), api) });
    expect(out).toEqual({ updates: [], requests: 0, listings: 0, days: 0 });
    expect(api.requests).toEqual([]);
  });

  test('a day cut short by the budget is not parked in the cursor for another pass', async () => {
    const store = fakeStore({ cursor: { spend: { hour: m.utcHour(NOW), calls: 479 } } });
    const api = fakeApi({ broadcast: [broadcast(5001)] });
    const out = await m.syncBroadcasts({ events: [afl], ...opts(store, api) });
    // One request left: the day before is read, the day of is not.
    expect(api.requests).toHaveLength(1);
    expect(out.updates).toEqual([]);
    expect(out.exhausted).toBe(true);
    expect(store.state.cursor.pending ?? null).toBeNull();
  });

  test('pageUrl carries the tags the day walk is narrowed by', () => {
    const url = new URL(
      m.pageUrl({
        base: 'https://nichedb.dev/api/v1',
        kind: 'broadcast',
        tags: ['broadcast', 'date:2026-09-13'],
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      collection: 'sports',
      kind: 'broadcast',
      sort: 'id',
      order: 'asc',
      limit: '200',
      tags: 'broadcast,date:2026-09-13',
    });
  });
});

describe('the shared matcher', () => {
  test('the direct fill and the mirror produce the same update from the same rows', async () => {
    const rows = [
      m.mapBroadcast(broadcast(5001)),
      m.mapBroadcast(broadcast(5003, { event: 'Carlton vs Fremantle', channel: 'Kayo' })),
    ];
    const asked = [];
    const updates = await sportsdb.broadcastUpdates([afl], async (e, day) => {
      asked.push([e.id, day]);
      return day === '2026-09-13' ? rows : [];
    });
    expect(asked).toEqual([
      [455, '2026-09-12'],
      [455, '2026-09-13'],
    ]);
    expect(updates).toEqual([
      {
        id: 455,
        broadcast: '7 Queensland',
        country: 'Australia',
        markets: [{ country: 'Australia', channels: ['7 Queensland'] }],
      },
    ]);
  });
});

/* ----------------------------------------------------------------- schema -- */

describe('the rows fit the tables', () => {
  let db;
  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
  }, 60_000);

  test('a mapped play lands in event_plays and a re-insert is a no-op', async () => {
    const { rows: l } = await db.query(
      `insert into leagues (provider, provider_key, sport, slug, name) values ('espn', 'football/nfl', 'football', 'football-nfl', 'NFL') returning id`,
    );
    const { rows: e } = await db.query(
      `insert into events (provider, provider_key, league_id, starts_at, name) values ('espn', 'football/nfl/401772510', $1, now(), 'NE @ DEN') returning id`,
      [l[0].id],
    );
    const insert = async (p) => {
      const row = { event_id: e[0].id, ...p };
      const cols = Object.keys(row);
      const { rows } = await db.query(
        `insert into event_plays (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         on conflict (event_id, provider_play_id) do nothing returning id`,
        cols.map((c) => row[c]),
      );
      return rows.length;
    };
    const { plays } = m.mapPlays(finalPlays());
    let added = 0;
    for (const p of plays) added += await insert(p);
    expect(added).toBe(5);
    for (const p of plays) added += await insert(p);
    expect(added).toBe(5);
    const { rows } = await db.query(
      `select provider_play_id, period_number, period_label, play_type, home_score, scoring
         from event_plays where event_id = $1 order by sequence`,
      [e[0].id],
    );
    expect(rows[1]).toEqual({
      provider_play_id: '2',
      period_number: 1,
      period_label: '13:43 · 1st',
      play_type: 'Rush',
      home_score: 7,
      scoring: true,
    });
    expect(rows[4].period_label).toBe('0:00 · 4th');
  });
});
