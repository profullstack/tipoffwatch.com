import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const { config } = await import('../packages/config/src/index.js');
const livetennis = await import('../packages/sports/src/livetennis.js');

config.sports.livetennis.apiKey = 'twjp_test';
config.sports.livetennis.tapeTours = ['atp', 'wta'];
config.sports.livetennis.tapeBudget = 30;
config.sports.livetennis.tapeMinIntervalSeconds = 1200;
config.sports.livetennis.dailyBudget = 95;

/**
 * A tape entry is the WHOLE score at a moment, not a described event.
 *
 * Shape copied from a real /history/matches/{id} response. `games` keeps every set
 * played so far, so [[7,3],[5,2]] is "7-5, then 3-2".
 */
const at = (min, sets, games, points, server, extra = {}) => ({
  timestamp: `2026-08-29T11:${String(min).padStart(2, '0')}:00.000000Z`,
  sets,
  games,
  points,
  server,
  is_tiebreak: false,
  ...extra,
});

const tape = [
  // p2 serving at 0-0, wins the game: a hold.
  at(0, [0, 0], [[0], [0]], ['15', '30'], 2),
  at(1, [0, 0], [[0], [0]], ['15', '40'], 2),
  at(2, [0, 0], [[0], [1]], ['0', '0'], 1),
  // p1 serving, p1 wins: a hold.
  at(3, [0, 0], [[0], [1]], ['15', '0'], 1),
  at(4, [0, 0], [[1], [1]], ['0', '0'], 2),
  // p2 serving, p1 wins: a break.
  at(5, [0, 0], [[2], [1]], ['0', '0'], 1),
  // p1 serving, p1 wins the game AND the set in the same entry. The finished set
  // reads 7-5 in `cur`, while `prev` still says 6-5.
  at(6, [0, 0], [[6], [5]], ['40', '30'], 1),
  at(
    7,
    [1, 0],
    [
      [7, 0],
      [5, 0],
    ],
    ['0', '0'],
    2,
  ),
];

const body = {
  match: {
    players: { p1: { name: 'George Loffhagen' }, p2: { name: 'Charles Broom' } },
  },
  tape,
};

let requests = [];
const realFetch = globalThis.fetch;

/** Every file that reaches for the global owes it back -- bun test shares a process. */
afterAll(() => {
  globalThis.fetch = realFetch;
});

const mock = (payload = body, { status = 200 } = {}) => {
  globalThis.fetch = async (url) => {
    requests.push(String(url).split('/api/public/v1')[1]);
    return new Response(JSON.stringify(payload), { status });
  };
};

beforeEach(() => {
  livetennis.resetBudget();
  config.sports.livetennis.tapeTours = ['atp', 'wta'];
  config.sports.livetennis.tapeBudget = 30;
  config.sports.livetennis.tapeMinIntervalSeconds = 1200;
  requests = [];
});

const plays = (id = 'livetennis/atp/180159', tour = 'atp') =>
  livetennis.fetchPlays(tour, id, { log: () => {} });

describe('turning a tape into a log', () => {
  test('a hold, a break and a set each read as what they are', async () => {
    mock();
    const out = await plays();
    const notPoints = out.filter((p) => p.playType !== 'point');

    expect(notPoints.map((p) => p.text)).toEqual([
      'Charles Broom holds — 0-1',
      'George Loffhagen holds — 1-1',
      'George Loffhagen breaks — 2-1',
      // The fixture jumps 2-1 -> 6-5 in one entry, which is a gap rather than a
      // game. See the test below for why that must not read as a hold.
      'Games — 6-5',
      'George Loffhagen takes set 1 — 7-5',
    ]);
  });

  test('a gap of several games is not narrated as one hold', async () => {
    // The tape is sampled, not exhaustive -- its own meta calls the coverage
    // "partial" -- so two entries can straddle several games. `server` belongs to
    // the first of them, and spending it on a line covering four asserts a break
    // that may never have happened.
    mock();
    const gap = (await plays()).find((p) => p.playType === 'games');
    expect(gap.text).toBe('Games — 6-5');
    expect(gap.text).not.toMatch(/holds|breaks/);
  });

  test('who was serving is what separates a hold from a break', async () => {
    // The single most-read fact in a tennis log, and it comes from the PREVIOUS
    // entry -- by the time a game is won the server has already changed.
    mock();
    const out = await plays();
    const brk = out.find((p) => p.playType === 'break');
    expect(brk.text).toBe('George Loffhagen breaks — 2-1');
    expect(brk.scoring).toBe(true);
  });

  test('the set scoreline is the finished set, not one game short of it', async () => {
    // Regression: the game that wins a set and the set land in the SAME entry, so
    // reading `prev` reported a set won 7-5 as "6-5" -- a wrong scoreline in a
    // permanent record rather than merely a late one.
    mock();
    const set = (await plays()).find((p) => p.playType === 'set');
    expect(set.text).toBe('George Loffhagen takes set 1 — 7-5');
    expect(set.awayScore).toBe(1);
    expect(set.homeScore).toBe(0);
  });

  test('a point is attributed to whoever won it', async () => {
    mock();
    const [first] = await plays();
    expect(first.text).toBe('Charles Broom — 15-40');
    expect(first.playType).toBe('point');
    expect(first.scoring).toBe(false);
  });

  test('every row is uniquely keyed and ordered, so re-reading appends only new points', async () => {
    // The rail re-fetches the whole tape every poll and relies on
    // unique(event_id, provider_play_id) to append the difference.
    mock();
    const out = await plays();
    expect(new Set(out.map((p) => p.providerPlayId)).size).toBe(out.length);
    expect(out.every((p, i) => i === 0 || p.sequence >= out[i - 1].sequence)).toBe(true);
    expect(out.every((p) => p.periodLabel?.startsWith('Set '))).toBe(true);
  });

  test('a tiebreak counts in numbers, not in 15/30/40', async () => {
    const tb = [
      at(0, [0, 0], [[6], [6]], ['3', '4'], 1, { is_tiebreak: true }),
      at(1, [0, 0], [[6], [6]], ['4', '4'], 1, { is_tiebreak: true }),
    ];
    mock({ ...body, tape: tb });
    const [p] = await plays();
    expect(p.text).toBe('George Loffhagen — tiebreak 4-4');
    expect(p.playType).toBe('tiebreak-point');
  });

  test('an unreadable move is left undescribed rather than invented', async () => {
    const odd = [
      at(0, [0, 0], [[1], [1]], ['??', '??'], 1),
      at(1, [0, 0], [[1], [1]], ['?!', '?!'], 1),
    ];
    mock({ ...body, tape: odd });
    expect(await plays()).toEqual([]);
  });
});

describe('what the budget will not pay for', () => {
  test('a tour we do not tape costs no request at all', async () => {
    // ITF is most of the calendar by volume and the least of the interest.
    mock();
    expect(await plays('livetennis/itf/1', 'itf')).toEqual([]);
    expect(requests).toEqual([]);
  });

  test('the same match is not re-taped inside the cooldown', async () => {
    // The plays rail asks every two minutes; one request per match per ask is 700
    // a day on an allowance of 100.
    mock();
    expect((await plays()).length).toBeGreaterThan(0);
    expect(await plays()).toEqual([]);
    expect(requests.length).toBe(1);
  });

  test('the tape has its own ceiling and cannot reach into the scores’', async () => {
    mock();
    config.sports.livetennis.tapeBudget = 0;
    expect(await plays()).toEqual([]);
    expect(requests).toEqual([]);
    // The scores' budget is untouched, which is the whole point of the split.
    expect(livetennis.spentToday().calls).toBe(0);
  });

  test('a refusal upstream is not an exception, it is an empty log', async () => {
    // The caller stamps the row and moves on. A log is an addition to a fixture,
    // never the fixture itself.
    mock({ error: 'upgrade_required' }, { status: 403 });
    expect(await plays()).toEqual([]);
  });

  test('a spent request still counts even when the answer is unusable', async () => {
    // The cooldown is stamped before the await, so two overlapping ticks on one
    // match cannot both spend on it.
    mock({ ...body, tape: [] });
    expect(await plays()).toEqual([]);
    expect(livetennis.spentToday().tape).toBe(1);
    expect(await plays()).toEqual([]);
    expect(requests.length).toBe(1);
  });
});
