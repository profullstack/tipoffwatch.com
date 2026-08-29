import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const { config } = await import('../packages/config/src/index.js');
const livetennis = await import('../packages/sports/src/livetennis.js');

/**
 * The adapter reads its knobs through config at call time, so the settings are put
 * here rather than in the environment -- which would have to be in place before the
 * config module was first imported by anything at all, in a suite that shares a
 * process.
 */
config.sports.livetennis.apiKey = 'twjp_test';
config.sports.livetennis.liveTtlSeconds = 1800;
config.sports.livetennis.fixturesTtlSeconds = 21600;
config.sports.livetennis.dailyBudget = 95;

/** A trimmed live singles match -- shape copied from a real /matches response. */
const liveSingles = {
  id: 180216,
  tour: 'itf',
  tournament: 'W15 Monastir 23',
  tournament_id: '4905',
  scheduled_time: '2026-08-29T08:00:00Z',
  status: 'live',
  outcome: null,
  event_status: null,
  round: 'W15 Monastir 23 - Semi-finals',
  round_code: 'SF',
  surface: 'hard',
  indoor: false,
  is_doubles: false,
  is_qualifying: false,
  players: {
    p1: { id: 2487, name: 'Riko Kikawada', country: 'jpn', ranking: 1182, is_doubles_team: false },
    p2: {
      id: 2844,
      name: 'Clarissa Blomqvist',
      country: 'fin',
      ranking: 1034,
      is_doubles_team: false,
    },
  },
  // Third set, 5-1, 0-0 in the game being played. Sets stand at one apiece.
  score: {
    sets: [1, 1],
    games: [
      [7, 4, 5],
      [6, 6, 1],
    ],
    points: ['40', 'AD'],
    is_tiebreak: false,
    server: 2,
  },
};

/** A doubles pair carrying the same numeric id as a singles player elsewhere. */
const liveDoubles = {
  id: 180215,
  tour: 'atp',
  tournament: 'Winston-Salem',
  tournament_id: '911',
  scheduled_time: '2026-08-29T09:00:00Z',
  status: 'live',
  is_doubles: true,
  is_qualifying: false,
  players: {
    p1: { id: 2487, name: 'Arends / Pel', is_doubles_team: true },
    p2: { id: 33466, name: 'Blomqvist / Vagramov', is_doubles_team: true },
  },
  score: { sets: [0, 1], games: [[4], [6]], points: ['15', '30'], is_tiebreak: false },
};

/** No tour at all. Real: UTR events and exhibitions come through like this. */
const untoured = {
  id: 180999,
  tour: null,
  tournament: 'UTR PTT Glasgow Men 01',
  tournament_id: '7001',
  scheduled_time: '2026-08-29T10:00:00Z',
  status: 'live',
  is_doubles: false,
  players: {
    p1: { id: 900, name: 'A Player', is_doubles_team: false },
    p2: { id: 901, name: 'B Player', is_doubles_team: false },
  },
  score: { sets: [0, 0], games: [[1], [2]], points: ['40', 'A'], is_tiebreak: false },
};

const upcomingSingles = {
  id: 180300,
  tour: 'atp',
  tournament: 'Winston-Salem',
  tournament_id: '911',
  scheduled_time: '2026-08-29T14:00:00Z',
  status: 'upcoming',
  round: 'Quarter-finals',
  round_code: 'QF',
  surface: 'hard',
  is_doubles: false,
  players: {
    p1: { id: 55, name: 'Carlos Alcaraz', country: 'esp', ranking: 1, is_doubles_team: false },
    p2: { id: 56, name: 'Jannik Sinner', country: 'ita', ranking: 2, is_doubles_team: false },
  },
  score: null,
};

/** The same fixture as liveSingles, one refresh later: over, and retired. */
const finishedSingles = {
  ...liveSingles,
  status: 'completed',
  outcome: 'retired',
  event_status: 'Finished',
  score: {
    sets: [2, 1],
    games: [
      [7, 4, 6],
      [6, 6, 3],
    ],
    points: ['0', '0'],
    is_tiebreak: false,
  },
};

/** Requests the mock saw, so a test can assert on cost rather than on behaviour alone. */
let calls = [];

/** Captured before any test can replace it. Restored in afterAll below. */
const realFetch = globalThis.fetch;

/**
 * Answer each list endpoint from a fixed set of rows.
 *
 * `status` decides which list a row belongs to, the same way the provider does, so
 * a fixture only has to be written once to appear in the right place.
 */
function mockProvider(rows, { fail = null, used = 0, perDay = 100 } = {}) {
  globalThis.fetch = async (url) => {
    const path = String(url).replace('https://api.livetennisapi.com/api/public/v1', '');
    // Seeded once per process from the provider's own count; not a list read, and
    // deliberately not counted as one.
    if (path.startsWith('/usage')) {
      return new Response(JSON.stringify({ today: { calls: used }, limits: { per_day: perDay } }), {
        status: 200,
      });
    }
    calls.push(path);
    if (fail?.(path)) return new Response('{"error":"upgrade_required"}', { status: 403 });

    const list = path.startsWith('/history')
      ? rows.filter((r) => r.status === 'completed')
      : path.includes('status=live')
        ? rows.filter((r) => r.status === 'live')
        : rows.filter((r) => r.status === 'upcoming');

    return new Response(JSON.stringify({ data: list, meta: { has_more: false } }), { status: 200 });
  };
}

const WINDOW = {
  from: new Date('2026-08-29T00:00:00Z'),
  to: new Date('2026-08-31T00:00:00Z'),
};

const schedule = async (tour) => {
  const r = await livetennis.fetchSchedule({ providerKey: tour, ...WINDOW, log: () => {} });
  return {
    ...r,
    tournaments: r.events.filter((e) => !e.home && !e.away),
    matches: r.events.filter((e) => e.home && e.away),
  };
};

/**
 * The real fetch, put back when this file is done.
 *
 * mockProvider replaces `globalThis.fetch`, and `bun test` runs every file in one
 * process -- so without this the mock outlives the file and answers for whoever
 * runs next. "livetennis" sorts before "stream-", and stream-proxy.test.js and
 * stream-probe.test.js fetch a real localhost server: they were being handed a
 * tennis API mock instead, which failed 19 tests that pass perfectly well on
 * their own. A file that reaches for a global owes it back.
 */
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  livetennis.resetBudget();
  calls = [];
});

describe('normalising a match', () => {
  test('reads as tennis: sets won, the set being played, and the points in the game', async () => {
    mockProvider([liveSingles]);
    const [m] = (await schedule('itf')).matches;

    expect(m.name).toBe('Riko Kikawada v Clarissa Blomqvist');
    expect(m.state).toBe('in');
    // Sets won -- one apiece. The games (7-6, 4-6, 5-1) are not a scoreline anyone
    // quotes, and their sum least of all.
    expect({ away: m.awayScore, home: m.homeScore }).toEqual({ away: 1, home: 1 });
    expect(m.period).toBe(3);
    expect(m.statusDetail).toBe('Set 3');
    expect(m.displayClock).toBe('40-AD');
  });

  test('p1 becomes the away side, because the fixture list renders away first', async () => {
    // "Kikawada vs Blomqvist" has to put the same two names in the same two places
    // the provider did; away is the one rendered on the left.
    mockProvider([liveSingles]);
    const [m] = (await schedule('itf')).matches;
    expect(m.away.name).toBe('Riko Kikawada');
    expect(m.home.name).toBe('Clarissa Blomqvist');
    expect(m.neutralSite).toBe(true);
  });

  test('the tournament is the venue, and the match details sit beside it', async () => {
    mockProvider([liveSingles]);
    const [m] = (await schedule('itf')).matches;
    expect(m.venue).toBe('W15 Monastir 23');
    expect(m.venueCity).toBe('W15 Monastir 23 - Semi-finals · singles · hard');
  });

  test('a tiebreak is labelled, because 6-5 there is not 40-30 in a game', async () => {
    mockProvider([
      { ...liveSingles, score: { ...liveSingles.score, points: ['6', '5'], is_tiebreak: true } },
    ]);
    const [m] = (await schedule('itf')).matches;
    expect(m.displayClock).toBe('TB 6-5');
  });

  test('a retirement is a result, and must not read as "completed"', async () => {
    mockProvider([finishedSingles]);
    const [m] = (await schedule('itf')).matches;
    expect(m.state).toBe('post');
    expect(m.statusDetail).toBe('Retired');
  });

  test('a doubles pair cannot collide with a singles player of the same id', async () => {
    // Both are id 2487 in different id spaces. The team slug is built from the last
    // path segment of this key, so folding them together puts two unrelated
    // competitors on one unique index mid-sync.
    mockProvider([liveSingles, liveDoubles]);
    const singles = (await schedule('itf')).matches[0];
    const doubles = (await schedule('atp')).matches[0];

    expect(singles.away.providerKey).toBe('livetennis/p2487');
    expect(doubles.away.providerKey).toBe('livetennis/d2487');
  });

  test('a player key carries no tour, so one person is followed once', async () => {
    // The opposite of ESPN, where an id means nothing without its league. A player
    // in an ITF draw this week and a Challenger next week is one person; the league
    // membership is an edge, not part of the identity.
    mockProvider([liveSingles, { ...liveSingles, id: 9, tour: 'challenger' }]);
    const itf = (await schedule('itf')).matches[0];
    const ch = (await schedule('challenger')).matches[0];
    expect(itf.away.providerKey).toBe(ch.away.providerKey);
    expect(itf.providerKey).not.toBe(ch.providerKey);
  });

  test('the ranking stands in for an abbreviation; a pair has none', async () => {
    mockProvider([upcomingSingles, liveDoubles]);
    const [m] = (await schedule('atp')).matches.filter((e) => e.away.name === 'Carlos Alcaraz');
    expect(m.away.abbreviation).toBe('#1');
    const [d] = (await schedule('atp')).matches.filter((e) => e.away.name === 'Arends / Pel');
    expect(d.away.abbreviation).toBe(null);
  });
});

describe('tours', () => {
  test('each tour sees only its own matches', async () => {
    mockProvider([liveSingles, liveDoubles, upcomingSingles]);
    expect((await schedule('itf')).matches.map((m) => m.name)).toEqual([
      'Riko Kikawada v Clarissa Blomqvist',
    ]);
    expect((await schedule('atp')).matches.length).toBe(2);
    expect((await schedule('wta')).matches).toEqual([]);
  });

  test('a match with no tour lands in "other" rather than being dropped', async () => {
    // Real fixtures with real players. Forcing them into ITF would be a lie and
    // dropping them is how a sport ends up with holes nobody can explain.
    mockProvider([untoured]);
    expect((await schedule('other')).matches.length).toBe(1);
    expect((await schedule('itf')).matches).toEqual([]);
  });

  test('the catalogue costs the provider nothing', async () => {
    const leagues = await livetennis.listLeagues();
    expect(leagues.map((l) => l.slug)).toEqual([
      'tennis-atp',
      'tennis-wta',
      'tennis-challenger',
      'tennis-itf',
      'tennis-other',
    ]);
    expect(leagues.every((l) => l.sport === 'tennis')).toBe(true);
    // /tournaments is 10,222 rows of history rather than a list of leagues, and
    // there have been four tours for decades.
    expect(calls).toEqual([]);
  });

  test('tennis is claimed outright', () => {
    expect(livetennis.claimsSports).toEqual(['tennis']);
  });
});

describe('what is deliberately not stored', () => {
  test('no tournament rows are synthesised from a two-day window', async () => {
    // The ESPN adapter does store the tournament itself, and should: its scoreboard
    // lists a fortnight before the draw exists. This provider publishes about two
    // days out, so a tournament inferred from its matches cannot exist before the
    // tournament does -- and arrives duplicated (tournament_id is per DRAW:
    // Winston-Salem is both t1216 and t1214) with a start time that moves forward
    // every day. The name is on every match as its venue instead.
    mockProvider([liveDoubles, upcomingSingles]);
    const { tournaments, matches } = await schedule('atp');

    expect(tournaments).toEqual([]);
    expect(matches.length).toBe(2);
    expect(matches.map((m) => m.venue)).toEqual(['Winston-Salem', 'Winston-Salem']);
  });
});

describe('the request budget, which shapes everything', () => {
  test('four tours share one read of the provider', async () => {
    // The whole reason this adapter is not written per league like espn.js. One
    // /matches response already holds every tour.
    mockProvider([liveSingles, liveDoubles, upcomingSingles]);
    for (const tour of ['atp', 'wta', 'challenger', 'itf']) await schedule(tour);

    // live, upcoming and recent -- once each, not once per tour.
    expect(calls.length).toBe(3);
    // Four against the budget, not three: seeding the day's count from /usage is
    // itself a request the provider charges for. Once per process, and the price of
    // a guard that survives a deploy.
    expect(livetennis.spentToday().calls).toBe(4);
    expect(livetennis.spentToday().seeded).toBe(true);
  });

  test('a snapshot is not refreshed inside its TTL', async () => {
    // The live tick asks every 60 seconds. At 100 requests a day it cannot be
    // answered from upstream every time, and it is not.
    mockProvider([liveSingles]);
    await schedule('itf');
    const first = calls.length;
    await schedule('itf');
    await schedule('itf');
    expect(calls.length).toBe(first);
  });

  test('past the ceiling it serves the snapshot it holds rather than throwing', async () => {
    mockProvider([liveSingles]);
    await schedule('itf');

    // Expire the snapshot and close the budget in the same breath: the next pass
    // wants a fresh read and cannot have one.
    config.sports.livetennis.liveTtlSeconds = 0;
    config.sports.livetennis.dailyBudget = livetennis.spentToday().calls;

    const { matches } = await schedule('itf');
    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe('Riko Kikawada v Clarissa Blomqvist');

    config.sports.livetennis.liveTtlSeconds = 1800;
    config.sports.livetennis.dailyBudget = 95;
  });

  test('an empty page is better than a failure when the results list is not ours', async () => {
    // Paging completed matches is a Basic capability and 403s on a free key. The
    // closing read is lost; the fixtures are not.
    mockProvider([liveSingles], { fail: (p) => p.startsWith('/history') });
    const { matches } = await schedule('itf');
    expect(matches.length).toBe(1);
  });

  test('a finished match wins over the live row it replaces', async () => {
    // A match sits in both lists for a moment. Ordering the merge least-current
    // first is what stops a fixture being left at `in` with a stale score.
    mockProvider([{ ...liveSingles, status: 'live' }, finishedSingles]);
    const [m] = (await schedule('itf')).matches;
    expect(m.state).toBe('post');
    expect({ away: m.awayScore, home: m.homeScore }).toEqual({ away: 2, home: 1 });
  });
});

describe('the score two integers cannot hold', () => {
  test('games per set, the server and the points all survive the adapter', async () => {
    // The whole reason tennis has its own provider. Sets won is 1-1, which is true
    // and says almost nothing; this is the score anyone actually reads.
    mockProvider([liveSingles]);
    const [m] = (await schedule('itf')).matches;

    expect(m.scoreDetail).toEqual({
      kind: 'tennis',
      games: [
        [7, 4, 5],
        [6, 6, 1],
      ],
      points: ['40', 'AD'],
      tiebreak: false,
      // server 2 is p2, and p2 renders as the home side.
      serving: 'home',
    });
  });

  test('the array order is [away, home], so a renderer can zip it against the sides', async () => {
    mockProvider([liveSingles]);
    const [m] = (await schedule('itf')).matches;
    // p1 is away and won the first set 7-6.
    expect(m.away.name).toBe('Riko Kikawada');
    expect(m.scoreDetail.games[0][0]).toBe(7);
    expect(m.scoreDetail.games[1][0]).toBe(6);
  });

  test('a finished match keeps its games and sheds its points and server', async () => {
    // Per-set games IS the result -- "6-4 4-6 7-5" is what gets quoted afterwards.
    // The last points read "0-0" and a server on a court nobody is standing on is
    // worse than nothing.
    mockProvider([finishedSingles]);
    const [m] = (await schedule('itf')).matches;

    expect(m.scoreDetail.games).toEqual([
      [7, 4, 6],
      [6, 6, 3],
    ]);
    expect(m.scoreDetail.points).toBe(null);
    expect(m.scoreDetail.serving).toBe(null);
    expect(m.scoreDetail.tiebreak).toBe(false);
  });

  test('a tiebreak says so, because 6-5 there is not 40-30 in a game', async () => {
    mockProvider([
      {
        ...liveSingles,
        score: { ...liveSingles.score, points: ['6', '5'], is_tiebreak: true },
      },
    ]);
    const [m] = (await schedule('itf')).matches;
    expect(m.scoreDetail.tiebreak).toBe(true);
    expect(m.scoreDetail.points).toEqual(['6', '5']);
  });

  test('a match that has not started has no board, rather than a grid of dashes', async () => {
    mockProvider([upcomingSingles]);
    const [m] = (await schedule('atp')).matches;
    expect(m.scoreDetail).toBe(null);
  });

  test('an empty per-set list is not a scoreline', async () => {
    mockProvider([
      { ...liveSingles, score: { sets: [0, 0], games: [[], []], points: ['0', '0'] } },
    ]);
    const [m] = (await schedule('itf')).matches;
    expect(m.scoreDetail).toBe(null);
  });

  test('a provider that says nothing about the server leaves it null', async () => {
    const { server, ...noServer } = liveSingles.score;
    mockProvider([{ ...liveSingles, score: noServer }]);
    const [m] = (await schedule('itf')).matches;
    expect(m.scoreDetail.serving).toBe(null);
    expect(m.scoreDetail.points).toEqual(['40', 'AD']);
  });
});

describe('the window', () => {
  test('a fixture outside it is not this pass’s business', async () => {
    mockProvider([liveSingles]);
    const r = await livetennis.fetchSchedule({
      providerKey: 'itf',
      from: new Date('2026-09-10T00:00:00Z'),
      to: new Date('2026-09-12T00:00:00Z'),
      log: () => {},
    });
    expect(r.events).toEqual([]);
    // The league's own name still comes back, so the sweep can still upgrade it.
    expect(r.league.name).toBe('ITF World Tennis Tour');
  });
});
