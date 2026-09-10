import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const m = await import('../packages/sports/src/nichedbsports.js');

/*
 * The nichedb-sports mirror: nichedb's `sports` collection projected into the
 * leagues, teams and events tables the ESPN and Live Tennis adapters write.
 *
 * The items below are shaped exactly as nichedb serialises them (itemOut in its
 * apps/web/src/lib/serialize.js, `data` per docs/consolidation.md), copied from
 * live responses on 2026-09-10 and trimmed. The store and the http client are
 * handed in, so every decision this provider makes -- which column gets which
 * field, when a snapshot is written, how a walk pages and resumes -- is asserted
 * without a database or the network.
 */

const NOW = Date.parse('2026-09-10T18:00:00.000Z');

/* ------------------------------------------------------------------ items -- */

const nflLeague = {
  id: 3598100,
  collection: 'sports',
  source: 'espn-catalogue',
  adapter: 'espn-catalogue',
  kind: 'league',
  title: 'NFL',
  summary: null,
  url: null,
  image_url: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png',
  published_at: null,
  time_known: false,
  precision: 'day',
  tags: ['league', 'football'],
  data: {
    provider: 'espn',
    sport: 'football',
    slug: 'football-nfl',
    key: 'football/nfl',
    name: 'NFL',
    abbreviation: 'NFL',
    logoUrl: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png',
    region: null,
    priority: 1,
    abbrAmbiguous: false,
    supersededBy: null,
    plays_supported: true,
    boxscoreSupported: true,
    teams: 32,
  },
  first_seen_at: '2026-09-10T14:02:56.407Z',
  enrichment: {},
  page: 'https://nichedb.dev/i/3598100',
};

const nblLeague = {
  ...nflLeague,
  id: 3598101,
  title: 'NBL',
  tags: ['league', 'basketball', 'region:australia'],
  data: {
    ...nflLeague.data,
    sport: 'basketball',
    slug: 'basketball-nbl',
    key: 'basketball/nbl',
    name: 'National Basketball League',
    abbreviation: 'NBL',
    region: 'Australia',
    priority: 100,
    abbrAmbiguous: true,
  },
};

const concacafDup = {
  ...nflLeague,
  id: 3598102,
  data: {
    ...nflLeague.data,
    sport: 'soccer',
    slug: 'soccer-concacaf-champions_cup',
    key: 'soccer/concacaf.champions_cup',
    name: 'CONCACAF Champions Cup',
    supersededBy: 'soccer/concacaf.champions',
  },
};

const atpLeague = {
  id: 3598201,
  collection: 'sports',
  source: 'livetennis',
  adapter: 'livetennis',
  kind: 'league',
  title: 'ATP Tour',
  summary: 'ATP',
  url: null,
  image_url: null,
  published_at: null,
  time_known: false,
  precision: 'day',
  tags: ['league', 'tennis'],
  data: {
    key: 'atp',
    name: 'ATP Tour',
    slug: 'tennis-atp',
    sport: 'tennis',
    region: null,
    logoUrl: null,
    priority: 3,
    provider: 'livetennis',
    abbreviation: 'ATP',
    supersededBy: null,
    abbrAmbiguous: false,
    plays_supported: false,
    boxscoreSupported: false,
  },
  first_seen_at: '2026-09-10T14:02:56.407Z',
  enrichment: {},
  page: 'https://nichedb.dev/i/3598201',
};

/** ESPN's tennis, should nichedb ever emit it: the same slug Live Tennis owns. */
const espnTennis = {
  ...atpLeague,
  id: 3598202,
  source: 'espn-catalogue',
  data: { ...atpLeague.data, provider: 'espn', key: 'tennis/atp' },
};

const broncos = {
  id: 3759076,
  collection: 'sports',
  source: 'espn-catalogue',
  adapter: 'espn-catalogue',
  kind: 'team',
  title: 'Denver Broncos',
  summary: 'Denver',
  url: 'https://www.espn.com/nfl/team/_/name/den/denver-broncos',
  image_url: 'https://a.espncdn.com/i/teamlogos/nfl/500/den.png',
  published_at: null,
  time_known: false,
  precision: 'day',
  tags: ['team', 'football', 'league:football-nfl'],
  data: {
    id: '7',
    key: 'football/nfl/7',
    name: 'Broncos',
    slug: 'football-nfl-7',
    color: '0a2343',
    sport: 'football',
    leagues: ['football-nfl', 'football-nfl-preseason'],
    logoUrl: 'https://a.espncdn.com/i/teamlogos/nfl/500/den.png',
    location: 'Denver',
    provider: 'espn',
    shortName: 'Broncos',
    displayName: 'Denver Broncos',
    abbreviation: 'DEN',
    alternateColor: 'fb4f14',
  },
  first_seen_at: '2026-09-10T14:05:16.466Z',
  enrichment: {},
  page: 'https://nichedb.dev/i/3759076',
};

const line = (spread) => ({
  provider: 'DraftKings',
  details: `DEN ${spread}`,
  spread,
  overUnder: 44.5,
  favorite: 'home',
  homeMoneyline: -185,
  awayMoneyline: 154,
  drawMoneyline: null,
  opening: { spread: -2.5, overUnder: 46.5, homeMoneyline: -175, awayMoneyline: 148 },
  capturedAt: '2026-09-10T17:59:00.000Z',
  capturedState: 'pre',
});

const nflFixture = (over = {}) => ({
  id: 3611950,
  collection: 'sports',
  source: 'espn-schedule',
  adapter: 'espn-schedule',
  kind: 'fixture',
  title: 'New England Patriots at Denver Broncos',
  summary: 'NE @ DEN',
  url: 'https://www.espn.com/nfl/game/_/gameId/401772510',
  image_url: 'https://a.espncdn.com/i/teamlogos/nfl/500/den.png',
  published_at: '2026-09-13T20:25:00.000Z',
  time_known: true,
  precision: 'minute',
  tags: [
    'fixture',
    'football',
    'league:football-nfl',
    'state:pre',
    'team:football-nfl-7',
    'team:football-nfl-17',
  ],
  data: {
    id: '401772510',
    key: 'football/nfl/401772510',
    provider: 'espn',
    sport: 'football',
    league: {
      key: 'football/nfl',
      name: 'NFL',
      slug: 'football-nfl',
      region: null,
      abbreviation: 'NFL',
    },
    name: 'New England Patriots at Denver Broncos',
    shortName: 'NE @ DEN',
    home: {
      id: '7',
      key: 'football/nfl/7',
      slug: 'football-nfl-7',
      name: 'Broncos',
      displayName: 'Denver Broncos',
      abbreviation: 'DEN',
      logoUrl: 'https://a.espncdn.com/i/teamlogos/nfl/500/den.png',
      score: 0,
      record: '1-0',
    },
    away: {
      id: '17',
      key: 'football/nfl/17',
      slug: 'football-nfl-17',
      name: 'Patriots',
      displayName: 'New England Patriots',
      abbreviation: 'NE',
      logoUrl: 'https://a.espncdn.com/i/teamlogos/nfl/500/ne.png',
      score: 0,
      record: '0-1',
    },
    state: 'pre',
    statusDetail: '9/13 - 4:25 PM EDT',
    period: 0,
    displayClock: '0:00',
    venue: 'Empower Field at Mile High',
    venueCity: 'Denver',
    venueRegion: 'CO',
    neutralSite: false,
    attendance: null,
    broadcast: 'CBS',
    broadcastSource: 'espn',
    broadcastMarkets: [{ country: 'United States', channels: ['CBS'] }],
    odds: line(-3.5),
    scoreDetail: null,
    plays_supported: true,
    boxscoreSupported: true,
    timeKnown: true,
    tournament: false,
    ...over,
  },
  first_seen_at: '2026-09-10T14:03:27.526Z',
  enrichment: {},
  page: 'https://nichedb.dev/i/3611950',
});

const tennisFixture = {
  id: 3620001,
  collection: 'sports',
  source: 'livetennis',
  adapter: 'livetennis',
  kind: 'fixture',
  title: 'Jannik Sinner vs Carlos Alcaraz',
  summary: 'US Open · Final',
  url: null,
  image_url: null,
  published_at: '2026-09-13T18:00:00.000Z',
  time_known: true,
  precision: 'minute',
  tags: [
    'fixture',
    'tennis',
    'league:tennis-atp',
    'state:in',
    'team:livetennis-p4382',
    'team:livetennis-p5220',
    'draw:singles',
  ],
  data: {
    provider: 'livetennis',
    sport: 'tennis',
    id: '918273',
    key: 'livetennis/atp/918273',
    league: { slug: 'tennis-atp', key: 'atp', name: 'ATP Tour', abbreviation: 'ATP', region: null },
    name: 'Jannik Sinner vs Carlos Alcaraz',
    shortName: null,
    home: {
      id: 'p5220',
      key: 'livetennis/p5220',
      slug: 'livetennis-p5220',
      name: 'Carlos Alcaraz',
      displayName: 'Carlos Alcaraz',
      abbreviation: '#2',
      logoUrl: null,
      score: 1,
      record: null,
      country: 'ES',
      ranking: 2,
    },
    away: {
      id: 'p4382',
      key: 'livetennis/p4382',
      slug: 'livetennis-p4382',
      name: 'Jannik Sinner',
      displayName: 'Jannik Sinner',
      abbreviation: '#1',
      logoUrl: null,
      score: 1,
      record: null,
      country: 'IT',
      ranking: 1,
    },
    state: 'in',
    statusDetail: 'Set 3',
    period: 3,
    displayClock: '30-15',
    venue: 'US Open',
    venueCity: 'Final · singles · hard',
    venueRegion: null,
    neutralSite: true,
    attendance: null,
    broadcast: null,
    broadcastSource: null,
    broadcastMarkets: null,
    odds: null,
    scoreDetail: {
      kind: 'tennis',
      games: [
        [6, 4, 2],
        [4, 6, 3],
      ],
      points: ['30', '15'],
      tiebreak: false,
      serving: 'away',
    },
    plays_supported: false,
    boxscoreSupported: false,
    timeKnown: true,
    tournament: false,
    tournamentName: 'US Open',
    tournamentId: '5011',
    round: 'Final',
    roundCode: 'F',
    surface: 'hard',
    indoor: false,
    doubles: false,
    qualifying: false,
  },
  first_seen_at: '2026-09-10T14:03:27.526Z',
  enrichment: {},
  page: 'https://nichedb.dev/i/3620001',
};

/** A fixture from a competition the catalogue has not delivered yet. */
const unknownLeagueFixture = {
  ...nflFixture(),
  id: 3630001,
  title: 'Newcomers at Upstarts',
  tags: ['fixture', 'soccer', 'league:soccer-xyz-1', 'state:pre'],
  data: {
    ...nflFixture().data,
    key: 'soccer/xyz.1/900001',
    sport: 'soccer',
    league: {
      key: 'soccer/xyz.1',
      name: 'Xyz Premier Division',
      slug: 'soccer-xyz-1',
      region: 'Xyzland',
      abbreviation: 'XPD',
    },
    home: { ...nflFixture().data.home, key: 'soccer/xyz.1/1', slug: 'soccer-xyz-1-1' },
    away: { ...nflFixture().data.away, key: 'soccer/xyz.1/2', slug: 'soccer-xyz-1-2' },
    odds: null,
    broadcast: null,
    broadcastSource: null,
    broadcastMarkets: null,
    plays_supported: true,
    boxscoreSupported: false,
  },
};

/* ------------------------------------------------------------------ fakes -- */

/**
 * The store, in memory, with the same identities the real tables enforce:
 * leagues and teams and events keyed on (provider, provider_key), ids assigned on
 * first sight, odds coalesced on conflict the way upsertEvents does.
 */
function fakeStore({ leagues = [], cursor = null } = {}) {
  let nextId = 1000;
  const s = {
    leagues: leagues.map((l, i) => ({ id: i + 1, active: true, ...l })),
    teams: new Map(),
    events: new Map(),
    links: [],
    snapshots: [],
    superseded: [],
    cursor,
    calls: [],
  };
  const key = (r) => `${r.provider}|${r.provider_key}`;
  const store = {
    state: s,
    async leagueIndex() {
      return s.leagues.map((l) => ({ ...l }));
    },
    async upsertLeague(row) {
      s.calls.push(['upsertLeague', row]);
      const held = s.leagues.find((l) => key(l) === key(row));
      if (held) {
        Object.assign(held, row, { active: true });
        return { ...held };
      }
      const saved = { id: nextId++, ...row };
      s.leagues.push(saved);
      return { ...saved };
    },
    async linkSuperseded(ref) {
      s.superseded.push(ref);
    },
    async upsertTeams(rows) {
      s.calls.push(['upsertTeams', rows]);
      return rows.map((r) => {
        const held = s.teams.get(key(r));
        if (held) {
          Object.assign(held, { name: r.name, display_name: r.display_name });
          return { id: held.id, provider_key: r.provider_key };
        }
        const saved = { id: nextId++, ...r };
        s.teams.set(key(r), saved);
        return { id: saved.id, provider_key: r.provider_key };
      });
    },
    async linkTeamsToLeague(ids, leagueId) {
      for (const id of ids) s.links.push([id, leagueId]);
    },
    async upsertEvents(rows) {
      s.calls.push(['upsertEvents', rows]);
      return rows.map((r) => {
        const held = s.events.get(key(r));
        if (held) {
          Object.assign(held, r, { odds: r.odds ?? held.odds });
          return { id: held.id, provider_key: r.provider_key };
        }
        const saved = { id: nextId++, ...r };
        s.events.set(key(r), saved);
        return { id: saved.id, provider_key: r.provider_key };
      });
    },
    async oddsByEventKeys(refs) {
      return refs
        .map((r) => s.events.get(key(r)))
        .filter(Boolean)
        .map((e) => ({
          id: e.id,
          provider: e.provider,
          provider_key: e.provider_key,
          // jsonb comes back parsed from the real table.
          odds: e.odds ? JSON.parse(e.odds) : null,
        }));
    },
    async recordOddsSnapshots(ids) {
      s.calls.push(['recordOddsSnapshots', ids]);
      s.snapshots.push(...ids);
      return ids.length;
    },
    async getCursor() {
      return s.cursor ? structuredClone(s.cursor) : null;
    },
    async setCursor(c) {
      s.cursor = structuredClone(c);
    },
  };
  return store;
}

/**
 * nichedb's items endpoint, over a fixed set of items per kind: keyset on id,
 * capped at 200, honouring `after`. `since` and `from` are recorded, not applied,
 * because what matters here is that the right one was asked for.
 */
function fakeApi(byKind) {
  const requests = [];
  const http = async (url) => {
    const u = new URL(url);
    const p = u.searchParams;
    requests.push({
      kind: p.get('kind'),
      after: Number(p.get('after')) || 0,
      since: p.get('since'),
      from: p.get('from'),
      sort: p.get('sort'),
      order: p.get('order'),
      limit: Number(p.get('limit')),
    });
    const after = Number(p.get('after')) || 0;
    const items = (byKind[p.get('kind')] ?? [])
      .filter((i) => i.id > after)
      .sort((a, b) => a.id - b.id)
      .slice(0, Math.min(Number(p.get('limit')) || 200, 200));
    return { count: items.length, items };
  };
  return { http, requests };
}

const quiet = () => {};

const knownLeagues = () => [
  { provider: 'espn', provider_key: 'football/nfl', slug: 'football-nfl', sport: 'football' },
  { provider: 'livetennis', provider_key: 'atp', slug: 'tennis-atp', sport: 'tennis' },
];

/* ---------------------------------------------------------------- mapping -- */

describe('mapLeague', () => {
  test('fills every leagues column from the item', () => {
    const row = m.mapLeague(nblLeague, { now: NOW });
    expect(row).toEqual({
      provider: 'espn',
      provider_key: 'basketball/nbl',
      sport: 'basketball',
      slug: 'basketball-nbl',
      name: 'National Basketball League',
      abbreviation: 'NBL',
      logo_url: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png',
      priority: 100,
      region: 'Australia',
      abbr_ambiguous: true,
      plays_supported: true,
      boxscore_supported: true,
      rosters_synced_at: new Date(NOW),
      active: true,
    });
  });

  test('keeps the provider the row came from, so a Live Tennis league stays livetennis', () => {
    const row = m.mapLeague(atpLeague, { now: NOW });
    expect(row).toMatchObject({
      provider: 'livetennis',
      provider_key: 'atp',
      slug: 'tennis-atp',
      priority: 3,
      plays_supported: false,
      boxscore_supported: false,
    });
  });

  test("drops ESPN's tennis, whose slug Live Tennis owns", () => {
    expect(m.mapLeague(espnTennis)).toBeNull();
  });

  test('names the competition a duplicate is superseded by', () => {
    expect(m.supersededKeyOf(concacafDup)).toBe('soccer/concacaf.champions');
    expect(m.supersededKeyOf(nflLeague)).toBeNull();
  });
});

describe('mapTeam', () => {
  test('fills the teams row and lists every league it plays in', () => {
    expect(m.mapTeam(broncos)).toEqual({
      row: {
        provider: 'espn',
        provider_key: 'football/nfl/7',
        name: 'Broncos',
        display_name: 'Denver Broncos',
        abbreviation: 'DEN',
        logo_url: 'https://a.espncdn.com/i/teamlogos/nfl/500/den.png',
      },
      leagues: ['football-nfl', 'football-nfl-preseason'],
    });
  });

  test('slugs a team the way the direct adapters do: league slug + upstream id', () => {
    expect(m.teamSlug('football-nfl', 'football/nfl/7')).toBe('football-nfl-7');
    expect(m.teamSlug('tennis-atp', 'livetennis/p4382')).toBe('tennis-atp-p4382');
  });
});

describe('mapFixture', () => {
  test('fills every events column from the fixture data', () => {
    const f = m.mapFixture(nflFixture());
    expect(f.league).toEqual(nflFixture().data.league);
    expect(f.event).toEqual({
      provider: 'espn',
      provider_key: 'football/nfl/401772510',
      starts_at: new Date('2026-09-13T20:25:00.000Z'),
      time_known: true,
      precision: 'minute',
      state: 'pre',
      status_detail: '9/13 - 4:25 PM EDT',
      name: 'New England Patriots at Denver Broncos',
      short_name: 'NE @ DEN',
      venue: 'Empower Field at Mile High',
      venue_city: 'Denver',
      venue_region: 'CO',
      neutral_site: false,
      broadcast: 'CBS',
      broadcast_source: 'espn',
      broadcast_country: 'United States',
      broadcast_markets: JSON.stringify([{ country: 'United States', channels: ['CBS'] }]),
      attendance: null,
      period: 0,
      display_clock: '0:00',
      score_detail: null,
      odds: JSON.stringify(line(-3.5)),
      home_record: '1-0',
      away_record: '0-1',
      home_score: 0,
      away_score: 0,
    });
    expect(f.home).toEqual({
      provider_key: 'football/nfl/7',
      name: 'Broncos',
      display_name: 'Denver Broncos',
      abbreviation: 'DEN',
      logo_url: 'https://a.espncdn.com/i/teamlogos/nfl/500/den.png',
    });
    expect(f.away.provider_key).toBe('football/nfl/17');
  });

  test('carries the tennis scoreline, the players as sides, and no listing', () => {
    const f = m.mapFixture(tennisFixture);
    expect(f.event).toMatchObject({
      provider: 'livetennis',
      provider_key: 'livetennis/atp/918273',
      state: 'in',
      status_detail: 'Set 3',
      period: 3,
      display_clock: '30-15',
      venue: 'US Open',
      venue_city: 'Final · singles · hard',
      neutral_site: true,
      broadcast: null,
      broadcast_source: null,
      broadcast_country: null,
      broadcast_markets: null,
      odds: null,
      home_score: 1,
      away_score: 1,
      home_record: null,
    });
    expect(JSON.parse(f.event.score_detail)).toEqual(tennisFixture.data.scoreDetail);
    expect(f.away).toMatchObject({ provider_key: 'livetennis/p4382', abbreviation: '#1' });
  });

  test('a date-only kickoff lands at day precision', () => {
    const f = m.mapFixture({ ...nflFixture(), time_known: false, precision: 'day' });
    expect(f.event).toMatchObject({ time_known: false, precision: 'day' });
  });

  test('a fixture with no start has no place on a calendar', () => {
    expect(m.mapFixture({ ...nflFixture(), published_at: null })).toBeNull();
  });

  test('a tournament header has no sides and still lands', () => {
    const f = m.mapFixture(nflFixture({ home: null, away: null, tournament: true }));
    expect(f.home).toBeNull();
    expect(f.away).toBeNull();
    expect(f.event).toMatchObject({ home_score: null, away_score: null, home_record: null });
  });
});

describe('state', () => {
  test('pre, in and post pass through; anything else is pre', () => {
    expect(m.stateOf({ state: 'pre' })).toBe('pre');
    expect(m.stateOf({ state: 'in' })).toBe('in');
    expect(m.stateOf({ state: 'post' })).toBe('post');
    expect(m.stateOf({ state: 'out' })).toBe('pre');
    expect(m.stateOf({})).toBe('pre');
    expect(m.mapFixture(nflFixture({ state: 'post' })).event.state).toBe('post');
  });
});

/* ------------------------------------------------------------------- odds -- */

describe('odds', () => {
  test('a line is unchanged when only its capture time moved', () => {
    const again = { ...line(-3.5), capturedAt: '2026-09-10T18:00:00.000Z', capturedState: 'in' };
    expect(m.oddsChanged(line(-3.5), again)).toBe(false);
  });

  test('a moved number is a change; nothing stored is a change; nothing arriving is not', () => {
    expect(m.oddsChanged(line(-3.5), line(-4))).toBe(true);
    expect(m.oddsChanged(null, line(-3.5))).toBe(true);
    expect(m.oddsChanged(line(-3.5), null)).toBe(false);
  });

  test('a snapshot is recorded when the line first lands and when it moves, not in between', async () => {
    const store = fakeStore({ leagues: knownLeagues() });
    const run = (fixture) =>
      m.syncSince({
        store,
        http: fakeApi({ fixture: [fixture] }).http,
        log: quiet,
        now: NOW,
        base: 'http://x',
      });

    await run(nflFixture());
    expect(store.state.snapshots).toHaveLength(1);

    // Same numbers, later capture: the everyday case, sixty times an hour.
    await run(nflFixture({ odds: { ...line(-3.5), capturedAt: '2026-09-10T18:01:00.000Z' } }));
    expect(store.state.snapshots).toHaveLength(1);
    expect(store.state.calls.filter(([c]) => c === 'recordOddsSnapshots')).toHaveLength(1);

    await run(nflFixture({ odds: line(-4) }));
    expect(store.state.snapshots).toHaveLength(2);

    // After kickoff the provider ships no line at all; the stored one must survive
    // (upsertEvents coalesces) and nothing is snapshotted.
    await run(nflFixture({ state: 'in', odds: null }));
    expect(store.state.snapshots).toHaveLength(2);
    const held = store.state.events.get('espn|football/nfl/401772510');
    expect(JSON.parse(held.odds).spread).toBe(-4);
  });
});

/* ---------------------------------------------------------------- writing -- */

describe('a fixture whose league is not yet known', () => {
  test('creates the league from data.league rather than being dropped', async () => {
    const store = fakeStore({ leagues: knownLeagues() });
    const api = fakeApi({ fixture: [unknownLeagueFixture] });
    const out = await m.syncSince({
      store,
      http: api.http,
      log: quiet,
      now: NOW,
      base: 'http://x',
    });

    expect(out.leaguesCreated).toBe(1);
    expect(out.fixtures).toBe(1);
    const created = store.state.leagues.find((l) => l.slug === 'soccer-xyz-1');
    expect(created).toMatchObject({
      provider: 'espn',
      provider_key: 'soccer/xyz.1',
      sport: 'soccer',
      name: 'Xyz Premier Division',
      abbreviation: 'XPD',
      region: 'Xyzland',
      priority: 100,
      plays_supported: true,
      boxscore_supported: false,
      // Not a roster sync: the boot check must still see this league as unswept.
      rosters_synced_at: null,
      active: true,
    });
    const event = store.state.events.get('espn|soccer/xyz.1/900001');
    expect(event.league_id).toBe(created.id);
    // Both sides were filed under the new league, with its slug.
    expect(store.state.teams.get('espn|soccer/xyz.1/1')).toMatchObject({
      league_id: created.id,
      slug: 'soccer-xyz-1-1',
    });
    expect(event.home_team_id).toBe(store.state.teams.get('espn|soccer/xyz.1/1').id);
  });

  test('a known league is never re-upserted from a fixture', async () => {
    const store = fakeStore({ leagues: knownLeagues() });
    const api = fakeApi({ fixture: [nflFixture(), tennisFixture] });
    const out = await m.syncSince({
      store,
      http: api.http,
      log: quiet,
      now: NOW,
      base: 'http://x',
    });
    expect(out.leaguesCreated).toBe(0);
    expect(store.state.calls.filter(([c]) => c === 'upsertLeague')).toHaveLength(0);
    expect(out.fixtures).toBe(2);
    expect(out.live).toBe(1);
    // The tennis players are teams too, under the tour's slug convention.
    expect(store.state.teams.get('livetennis|livetennis/p4382')).toMatchObject({
      slug: 'tennis-atp-p4382',
      display_name: 'Jannik Sinner',
    });
  });
});

describe('the catalogue', () => {
  test('writes leagues, links a team to every league it plays in, and points a duplicate at its survivor', async () => {
    const store = fakeStore({
      leagues: [
        {
          provider: 'espn',
          provider_key: 'soccer/concacaf.champions',
          slug: 'soccer-concacaf-champions',
          sport: 'soccer',
        },
        {
          provider: 'espn',
          provider_key: 'football/nfl-preseason',
          slug: 'football-nfl-preseason',
          sport: 'football',
        },
      ],
    });
    const api = fakeApi({
      league: [nflLeague, nblLeague, concacafDup, atpLeague, espnTennis],
      team: [broncos],
    });
    const out = await m.syncCatalogue({
      store,
      http: api.http,
      log: quiet,
      now: NOW,
      base: 'http://x',
    });

    expect(out.leagues).toBe(4);
    expect(out.teams).toBe(1);
    expect(api.requests.map((r) => r.kind)).toEqual(['league', 'team']);
    expect(store.state.leagues.map((l) => l.slug)).not.toContain('tennis-atp-espn');
    expect(store.state.superseded).toEqual([
      { id: expect.any(Number), provider: 'espn', providerKey: 'soccer/concacaf.champions' },
    ]);

    const nfl = store.state.leagues.find((l) => l.slug === 'football-nfl');
    const pre = store.state.leagues.find((l) => l.slug === 'football-nfl-preseason');
    const den = store.state.teams.get('espn|football/nfl/7');
    expect(den).toMatchObject({ league_id: nfl.id, slug: 'football-nfl-7' });
    expect(store.state.links).toEqual([
      [den.id, nfl.id],
      [den.id, pre.id],
    ]);
  });
});

/* ----------------------------------------------------------------- paging -- */

const manyFixtures = (n) =>
  Array.from({ length: n }, (_, i) => {
    const f = nflFixture({ key: `football/nfl/${500000 + i}`, odds: null });
    return { ...f, id: 4000000 + i };
  });

describe('paging and the cursor', () => {
  test('the first pass ever walks from the backfill floor, keyset on id, and sets since', async () => {
    const store = fakeStore({ leagues: knownLeagues() });
    const api = fakeApi({ fixture: manyFixtures(450) });
    const out = await m.syncSince({
      store,
      http: api.http,
      log: quiet,
      now: NOW,
      base: 'http://x',
    });

    expect(out.fixtures).toBe(450);
    expect(api.requests).toHaveLength(3);
    expect(api.requests.map((r) => r.after)).toEqual([0, 4000199, 4000399]);
    for (const r of api.requests) {
      expect(r).toMatchObject({
        kind: 'fixture',
        sort: 'id',
        order: 'asc',
        limit: 200,
        since: null,
      });
      expect(r.from).toBe(m.backfillFrom(NOW));
    }
    // Two minutes before the walk began, so a row that moved during it is re-read.
    expect(store.state.cursor.since).toBe(new Date(NOW - m.OVERLAP_MS).toISOString());
    expect(store.state.cursor.pending).toBeNull();
    expect(store.state.cursor.spend).toEqual({ hour: m.utcHour(NOW), calls: 3 });
  });

  test('every later pass asks only for what changed since', async () => {
    const store = fakeStore({
      leagues: knownLeagues(),
      cursor: { since: '2026-09-10T17:30:00.000Z' },
    });
    const api = fakeApi({ fixture: [nflFixture()] });
    await m.syncSince({ store, http: api.http, log: quiet, now: NOW, base: 'http://x' });

    expect(api.requests).toEqual([
      expect.objectContaining({
        kind: 'fixture',
        since: '2026-09-10T17:30:00.000Z',
        from: null,
        after: 0,
      }),
    ]);
    expect(store.state.cursor.since).toBe(new Date(NOW - m.OVERLAP_MS).toISOString());
  });

  test('a walk cut short by the hourly budget keeps its place and the next pass finishes it', async () => {
    const store = fakeStore({
      leagues: knownLeagues(),
      cursor: { since: '2026-09-10T17:30:00.000Z' },
    });
    const api = fakeApi({ fixture: manyFixtures(450) });
    const opts = { store, http: api.http, log: quiet, now: NOW, base: 'http://x', hourlyBudget: 2 };

    const first = await m.syncSince(opts);
    expect(first.exhausted).toBe(true);
    expect(first.fixtures).toBe(400);
    expect(api.requests).toHaveLength(2);
    expect(store.state.cursor.pending).toMatchObject({
      id: 'fixtures:since',
      kind: 'fixture',
      since: '2026-09-10T17:30:00.000Z',
      afterId: 4000399,
    });
    // Not advanced: the walk that would justify it has not finished.
    expect(store.state.cursor.since).toBe('2026-09-10T17:30:00.000Z');

    // Same hour, budget still spent: nothing is fetched and the position holds.
    const stalled = await m.syncSince(opts);
    expect(stalled.requests).toBe(0);
    expect(store.state.cursor.pending.afterId).toBe(4000399);

    // Next hour: resumes from where it stopped, with the ORIGINAL since.
    const later = NOW + 3_600_000;
    const done = await m.syncSince({ ...opts, now: later });
    expect(done.resumed).toEqual(['fixtures:since']);
    expect(api.requests[2]).toMatchObject({ after: 4000399, since: '2026-09-10T17:30:00.000Z' });
    expect(done.fixtures).toBe(50);
    expect(store.state.cursor.pending).toBeNull();
    // since is set from when the interrupted walk BEGAN, not when it was finished.
    expect(store.state.cursor.since).toBe(new Date(NOW - m.OVERLAP_MS).toISOString());
  });

  test('the full sweep walks leagues, teams and then fixtures from the floor', async () => {
    const store = fakeStore();
    const api = fakeApi({ league: [nflLeague], team: [broncos], fixture: [nflFixture()] });
    const out = await m.syncAll({ store, http: api.http, log: quiet, now: NOW, base: 'http://x' });
    expect(api.requests.map((r) => [r.kind, r.from, r.since])).toEqual([
      ['league', null, null],
      ['team', null, null],
      ['fixture', m.backfillFrom(NOW), null],
    ]);
    expect(out).toMatchObject({ leagues: 1, teams: 1, fixtures: 1, requests: 3 });
    // The catalogue's leagues are stamped as roster-synced; the boot check reads it.
    expect(store.state.leagues[0].rosters_synced_at).toEqual(new Date(NOW));
  });

  test('a pass already running is not run twice at once', async () => {
    const store = fakeStore({ leagues: knownLeagues() });
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const http = async () => {
      await gate;
      return { items: [] };
    };
    const first = m.syncSince({ store, http, log: quiet, now: NOW, base: 'http://x' });
    const second = await m.syncSince({ store, http, log: quiet, now: NOW, base: 'http://x' });
    expect(second.skipped).toMatch(/already running/);
    release();
    expect((await first).requests).toBe(1);
  });

  test('pageUrl asks nichedb exactly what the read API accepts', () => {
    const url = new URL(
      m.pageUrl({
        base: 'https://nichedb.dev/api/v1',
        kind: 'fixture',
        since: '2026-09-10T17:30:00.000Z',
        afterId: 42,
      }),
    );
    expect(url.pathname).toBe('/api/v1/items');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      collection: 'sports',
      kind: 'fixture',
      sort: 'id',
      order: 'asc',
      limit: '200',
      since: '2026-09-10T17:30:00.000Z',
      after: '42',
    });
  });
});

/* ----------------------------------------------------------------- switch -- */

describe('SPORTS_PROVIDERS=nichedb-sports', () => {
  test('takes every pass and leaves the direct adapters uncalled', async () => {
    // Switched the way tennis-claim.test.js switches it: config is a snapshot of
    // the environment taken at import, so the list is assigned, not the variable.
    const { config } = await import('../packages/config/src/index.js');
    const sports = await import('../packages/sports/src/index.js');
    const held = config.sports.providers;
    try {
      config.sports.providers = ['nichedb-sports'];
      expect(sports.mirrorEnabled()).toBe(true);
      expect(sports.adapters()).toEqual([]);
      expect([...sports.sportClaims()]).toEqual([]);

      // Listing both is not a boot error: rollback is one variable change.
      config.sports.providers = ['espn', 'nichedb-sports'];
      expect(sports.mirrorEnabled()).toBe(true);
      expect(sports.adapters()).toEqual([]);

      config.sports.providers = ['espn', 'livetennis'];
      expect(sports.mirrorEnabled()).toBe(false);
      expect(sports.adapters().map((a) => a.name)).toEqual(['espn', 'livetennis']);

      config.sports.providers = ['nope'];
      expect(() => sports.adapters()).toThrow(/Known: espn, livetennis, nichedb-sports/);
    } finally {
      config.sports.providers = held;
    }
  });
});

/* ----------------------------------------------------------------- schema -- */

describe('the sync_cursors migration', () => {
  let db;
  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
  }, 60_000);

  test('keeps one jsonb document per named cursor, replaced on conflict', async () => {
    const write = (c) =>
      db.query(
        `insert into sync_cursors (name, cursor, updated_at) values ($1, $2::jsonb, now())
         on conflict (name) do update set cursor = excluded.cursor, updated_at = now()`,
        ['nichedb-sports', JSON.stringify(c)],
      );
    await write({ since: 'a', pending: null });
    await write({ since: 'b', pending: { id: 'fixtures:since', afterId: 7 } });
    const { rows } = await db.query(
      `select cursor from sync_cursors where name = 'nichedb-sports'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cursor).toEqual({ since: 'b', pending: { id: 'fixtures:since', afterId: 7 } });
  });

  test('the mirrored league upsert lands every column the pages read', async () => {
    const row = m.mapLeague(nblLeague, { now: NOW });
    const cols = Object.keys(row);
    const vals = cols.map((c) => row[c]);
    const params = cols.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(`insert into leagues (${cols.join(', ')}) values (${params})`, vals);
    const { rows } = await db.query(
      `select name, abbreviation, region, priority, abbr_ambiguous, plays_supported,
              boxscore_supported, active, rosters_synced_at is not null as swept
         from leagues where slug = 'basketball-nbl'`,
    );
    expect(rows[0]).toEqual({
      name: 'National Basketball League',
      abbreviation: 'NBL',
      region: 'Australia',
      priority: 100,
      abbr_ambiguous: true,
      plays_supported: true,
      boxscore_supported: true,
      active: true,
      swept: true,
    });
  });

  test('the events row from a fixture fits the table', async () => {
    const { rows: l } = await db.query(
      `insert into leagues (provider, provider_key, sport, slug, name) values ('espn', 'football/nfl', 'football', 'football-nfl', 'NFL') returning id`,
    );
    const ev = { ...m.mapFixture(nflFixture()).event, league_id: l[0].id };
    const cols = Object.keys(ev);
    const params = cols.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `insert into events (${cols.join(', ')}) values (${params})`,
      cols.map((c) => ev[c]),
    );
    const { rows } = await db.query(
      `select state, broadcast_markets, odds -> 'spread' as spread, precision, time_known
         from events where provider_key = 'football/nfl/401772510'`,
    );
    expect(rows[0]).toEqual({
      state: 'pre',
      broadcast_markets: [{ country: 'United States', channels: ['CBS'] }],
      spread: -3.5,
      precision: 'minute',
      time_known: true,
    });
  });
});
