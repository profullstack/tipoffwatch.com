import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const m = await import('../packages/sports/src/nichedbsports.js');
const { SUPERSEDE_SPORTSDB_SQL } = await import('../packages/db/src/queries.js');

/*
 * TheSportsDB through the nichedb mirror: every competition ESPN does not
 * carry, and none of the ones it does. Items are shaped as nichedb's
 * sportsdb-schedule and sportsdb-leagues sources emit them (niche-db 0.50.0).
 */

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const quiet = () => {};

let nextItem = 9_000_000;
const sdbFixture = ({ id, league, leagueKey, sport = 'cricket', home, away, at } = {}) => ({
  id: nextItem++,
  collection: 'sports',
  source: 'sportsdb-schedule',
  kind: 'fixture',
  external_id: `thesportsdb:fixture:${id}`,
  title: `${home} vs ${away}`,
  published_at: at ?? '2026-10-27T07:00:00.000Z',
  updated_at: '2026-10-26T11:00:00.000Z',
  time_known: true,
  precision: 'minute',
  data: {
    provider: 'thesportsdb',
    id: String(id),
    key: String(id),
    sport,
    name: `${home} vs ${away}`,
    league: {
      key: leagueKey,
      slug: `${sport}-${league.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: league,
      logoUrl: 'https://r2.thesportsdb.com/league.png',
    },
    home: { key: `thesportsdb/team/${id}1`, name: home, displayName: home },
    away: { key: `thesportsdb/team/${id}2`, name: away, displayName: away },
    state: 'pre',
    plays_supported: false,
    boxscoreSupported: false,
  },
});

const t20 = (id = 2524756) =>
  sdbFixture({
    id,
    league: 'Twenty20 International Series',
    leagueKey: '4979',
    home: 'New Zealand Cricket',
    away: 'India Cricket',
  });

const sdbNba = sdbFixture({
  id: 777,
  league: 'NBA',
  leagueKey: '4387',
  sport: 'basketball',
  home: 'Boston Celtics',
  away: 'New York Knicks',
});

const sdbLeagueItem = (key, name, sport) => ({
  id: nextItem++,
  kind: 'league',
  source: 'sportsdb-leagues',
  external_id: `sportsdb:league:${key}`,
  title: name,
  image_url: 'https://r2.thesportsdb.com/badge.png',
  data: {
    provider: 'thesportsdb',
    key,
    slug: `${sport}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    sport,
    name,
    logoUrl: 'https://r2.thesportsdb.com/badge.png',
    region: 'New Zealand',
    priority: 200,
  },
});

/** Leagues, teams and events in memory, keyed as the tables are. */
function fakeStore(leagues = []) {
  let nextId = 100;
  const s = {
    leagues: leagues.map((l, i) => ({ id: i + 1, active: true, superseded_by: null, ...l })),
    teams: new Map(),
    events: new Map(),
    retired: 0,
  };
  const key = (r) => `${r.provider}|${r.provider_key}`;
  return {
    state: s,
    leagueIndex: async () => s.leagues.map((l) => ({ ...l })),
    async upsertLeague(row) {
      const held = s.leagues.find((l) => key(l) === key(row));
      if (held) {
        Object.assign(held, row, {
          rosters_synced_at: row.rosters_synced_at ?? held.rosters_synced_at,
        });
        return { ...held };
      }
      if (s.leagues.some((l) => l.slug === row.slug)) throw new Error(`slug taken: ${row.slug}`);
      const saved = { id: nextId++, superseded_by: null, ...row };
      s.leagues.push(saved);
      return { ...saved };
    },
    linkSuperseded: async () => {},
    async upsertTeams(rows) {
      return rows.map((r) => {
        const saved = s.teams.get(key(r)) ?? { id: nextId++, ...r };
        s.teams.set(key(r), saved);
        return { id: saved.id, provider_key: r.provider_key };
      });
    },
    linkTeamsToLeague: async () => {},
    async upsertEvents(rows) {
      return rows.map((r) => {
        const saved = s.events.get(key(r)) ?? { id: nextId++, ...r };
        Object.assign(saved, r);
        s.events.set(key(r), saved);
        return { id: saved.id, provider_key: r.provider_key };
      });
    },
    oddsByEventKeys: async () => [],
    recordOddsSnapshots: async () => 0,
    async supersedeSportsdb() {
      s.retired++;
      return 0;
    },
    getCursor: async () => null,
    setCursor: async () => {},
  };
}

function fakeApi(byKind) {
  return async (url) => {
    const p = new URL(url).searchParams;
    const after = Number(p.get('after')) || 0;
    const items = (byKind[p.get('kind')] ?? [])
      .filter((i) => i.id > after)
      .sort((a, b) => a.id - b.id);
    return { count: items.length, items };
  };
}

const espnNba = {
  provider: 'espn',
  provider_key: 'basketball/nba',
  slug: 'basketball-nba',
  sport: 'basketball',
};

const since = (store, byKind) =>
  m.syncSince({ store, http: fakeApi(byKind), log: quiet, now: NOW, base: 'http://x' });

describe('TheSportsDB fixtures', () => {
  test('a league ESPN does not carry is created from its first fixture', async () => {
    const store = fakeStore([espnNba]);
    const out = await since(store, { fixture: [t20(), t20(2524757)] });
    expect(out.leaguesCreated).toBe(1);
    expect(out.fixtures).toBe(2);
    const league = store.state.leagues.find((l) => l.provider === 'thesportsdb');
    expect(league).toMatchObject({
      provider_key: '4979',
      slug: 'cricket-twenty20-international-series',
      sport: 'cricket',
      priority: 200,
      plays_supported: false,
      logo_url: 'https://r2.thesportsdb.com/league.png',
    });
    // Stamped once at creation, or the boot check counts it rosterless forever.
    expect(league.rosters_synced_at).toBeInstanceOf(Date);
    const event = store.state.events.get('thesportsdb|2524756');
    expect(event).toMatchObject({
      league_id: league.id,
      name: 'New Zealand Cricket vs India Cricket',
    });
    expect(store.state.teams.get('thesportsdb|thesportsdb/team/25247561')).toMatchObject({
      slug: 'cricket-twenty20-international-series-25247561',
    });
    // A since-pass that created a league runs the dedupe.
    expect(store.state.retired).toBe(1);
  });

  test('a slug ESPN already has is ESPN’s competition: its games are not filed there', async () => {
    const store = fakeStore([espnNba]);
    const out = await since(store, { fixture: [sdbNba] });
    expect(out.covered).toBe(1);
    expect(out.fixtures).toBe(0);
    expect(store.state.events.size).toBe(0);
    expect(store.state.leagues).toHaveLength(1);
  });

  test('two TheSportsDB leagues that slugify alike both land, the second with its id', async () => {
    const a = sdbFixture({
      id: 1,
      league: 'National 2 Group D',
      leagueKey: '5001',
      sport: 'soccer',
      home: 'A',
      away: 'B',
    });
    const b = sdbFixture({
      id: 2,
      league: 'National 2 Group D',
      leagueKey: '5002',
      sport: 'soccer',
      home: 'C',
      away: 'D',
    });
    const store = fakeStore();
    await since(store, { fixture: [a, b] });
    expect(store.state.leagues.map((l) => l.slug).sort()).toEqual([
      'soccer-national-2-group-d',
      'soccer-national-2-group-d-5002',
    ]);
  });

  test('a superseded TheSportsDB league takes no more fixtures', async () => {
    const store = fakeStore([
      espnNba,
      {
        provider: 'thesportsdb',
        provider_key: '4979',
        slug: 'cricket-twenty20-international-series',
        sport: 'cricket',
        superseded_by: 1,
      },
    ]);
    const out = await since(store, { fixture: [t20()] });
    expect(out.covered).toBe(1);
    expect(store.state.events.size).toBe(0);
  });

  test('ESPN fixtures still find their league by slug', async () => {
    const store = fakeStore([espnNba]);
    const espnGame = {
      ...sdbNba,
      id: nextItem++,
      external_id: 'espn:fixture:basketball/nba/1',
      data: {
        ...sdbNba.data,
        provider: 'espn',
        key: 'basketball/nba/1',
        league: { slug: 'basketball-nba', key: 'basketball/nba' },
        home: { key: 'basketball/nba/1', displayName: 'Boston Celtics' },
        away: { key: 'basketball/nba/2', displayName: 'New York Knicks' },
      },
    };
    const out = await since(store, { fixture: [espnGame] });
    expect(out.fixtures).toBe(1);
    expect(store.state.events.get('espn|basketball/nba/1').league_id).toBe(1);
  });
});

describe('TheSportsDB catalogue', () => {
  test('fills in only leagues a fixture already created, keeping their slug', async () => {
    const store = fakeStore([
      espnNba,
      {
        provider: 'thesportsdb',
        provider_key: '4979',
        slug: 'cricket-twenty20-international-series',
        sport: 'cricket',
        rosters_synced_at: new Date('2026-10-01T00:00:00Z'),
      },
    ]);
    const out = await m.syncCatalogue({
      store,
      http: fakeApi({
        league: [
          sdbLeagueItem('4979', 'Twenty20 International Series', 'cricket'),
          sdbLeagueItem('4500', 'Defunct Cup', 'cricket'),
        ],
      }),
      log: quiet,
      now: NOW,
      base: 'http://x',
    });
    expect(out.leagues).toBe(1);
    const sdb = store.state.leagues.filter((l) => l.provider === 'thesportsdb');
    expect(sdb).toHaveLength(1);
    expect(sdb[0]).toMatchObject({ region: 'New Zealand', priority: 200 });
    // The catalogue is not a roster sync for this provider.
    expect(sdb[0].rosters_synced_at).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(store.state.retired).toBe(1);
  });
});

describe('supersedeSportsdbLeagues', () => {
  let db;
  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
  }, 60_000);

  const league = async (provider, key, sport, name, abbreviation = null) => {
    const { rows } = await db.query(
      `insert into leagues (provider, provider_key, sport, slug, name, abbreviation)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [provider, key, sport, `${provider}-${key}`, name, abbreviation],
    );
    return rows[0].id;
  };
  const team = async (provider, key, leagueId, name) => {
    const { rows } = await db.query(
      `insert into teams (provider, provider_key, league_id, slug, name, display_name)
       values ($1, $2, $3, $4, $5, $5) returning id`,
      [provider, key, leagueId, `${provider}-${key}`, name],
    );
    return rows[0].id;
  };
  let n = 0;
  const game = async (provider, leagueId, at, home, away) => {
    n++;
    await db.query(
      `insert into events (provider, provider_key, league_id, starts_at, name, home_team_id, away_team_id)
       values ($1, $2, $3, now() + $4::interval, 'g', $5, $6)`,
      [provider, `${provider}-${n}`, leagueId, at, home, away],
    );
  };

  test('retires TheSportsDB leagues ESPN carries, by name or by games, and nothing else', async () => {
    // By name: "MLB" against ESPN's abbreviation.
    const espnMlb = await league(
      'espn',
      'baseball/mlb',
      'baseball',
      'Major League Baseball',
      'MLB',
    );
    const sdbMlb = await league('thesportsdb', '4424', 'baseball', 'MLB');

    // By games: ESPN "LALIGA", TheSportsDB "Spanish La Liga", same fixtures.
    const espnLiga = await league('espn', 'soccer/esp.1', 'soccer', 'LALIGA', 'LALIGA');
    const sdbLiga = await league('thesportsdb', '4335', 'soccer', 'Spanish La Liga');
    const pairs = [
      ['Real Madrid', 'Barcelona', 'Real Madrid CF', 'FC Barcelona'],
      ['Atletico Madrid', 'Sevilla', 'Atlético Madrid', 'Sevilla FC'],
      ['Real Betis', 'Valencia', 'Real Betis Balompié', 'Valencia CF'],
      ['Girona', 'Osasuna', 'Girona FC', 'CA Osasuna'],
    ];
    for (const [i, [sh, sa, eh, ea]] of pairs.entries()) {
      const at = `${i + 1} days`;
      await game(
        'espn',
        espnLiga,
        at,
        await team('espn', `e${i}h`, espnLiga, eh),
        await team('espn', `e${i}a`, espnLiga, ea),
      );
      await game(
        'thesportsdb',
        sdbLiga,
        at,
        await team('thesportsdb', `s${i}h`, sdbLiga, sh),
        await team('thesportsdb', `s${i}a`, sdbLiga, sa),
      );
    }

    // Kept: cricket at the same minute as a La Liga game, nothing alike.
    const sdbT20 = await league('thesportsdb', '4979', 'cricket', 'Twenty20 International Series');
    for (const i of [0, 1, 2]) {
      await game(
        'thesportsdb',
        sdbT20,
        `${i + 1} days`,
        await team('thesportsdb', `c${i}h`, sdbT20, 'New Zealand Cricket'),
        await team('thesportsdb', `c${i}a`, sdbT20, 'India Cricket'),
      );
    }
    // Kept: a soccer league kicking off alongside La Liga with other clubs.
    const sdbOther = await league('thesportsdb', '4400', 'soccer', 'Slovak Super Liga');
    for (const i of [0, 1, 2]) {
      await game(
        'thesportsdb',
        sdbOther,
        `${i + 1} days`,
        await team('thesportsdb', `o${i}h`, sdbOther, 'Slovan Bratislava'),
        await team('thesportsdb', `o${i}a`, sdbOther, 'Spartak Trnava'),
      );
    }

    const first = await db.query(SUPERSEDE_SPORTSDB_SQL);
    expect(first.rows).toHaveLength(2);
    const { rows } = await db.query(
      `select id, superseded_by from leagues where provider = 'thesportsdb' order by id`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r.superseded_by]));
    expect(by[sdbMlb]).toBe(espnMlb);
    expect(by[sdbLiga]).toBe(espnLiga);
    expect(by[sdbT20]).toBeNull();
    expect(by[sdbOther]).toBeNull();

    // Idempotent.
    expect((await db.query(SUPERSEDE_SPORTSDB_SQL)).rows).toHaveLength(0);
  });
});
