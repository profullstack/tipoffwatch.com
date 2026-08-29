import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const { setScoreOf, SetScore } = await import('../apps/web/src/views/components.jsx');

const render = async (node) => (await node.toString()).toString();

/** What livetennis writes into events.score_detail for a live third set. */
const live = {
  kind: 'tennis',
  games: [
    [7, 4, 5],
    [6, 6, 1],
  ],
  points: ['40', 'AD'],
  tiebreak: false,
  serving: 'home',
};

const event = (score_detail) => ({
  away_name: 'Riko Kikawada',
  home_name: 'Clarissa Blomqvist',
  score_detail,
});

describe('reading score_detail', () => {
  test('takes the column parsed or as a string, because the driver decides', async () => {
    // jsonb comes back parsed on one client and as text on another, and every row
    // written before migration 0029 has nothing in it at all.
    expect(setScoreOf(event(live))).toEqual(live);
    expect(setScoreOf(event(JSON.stringify(live)))).toEqual(live);
  });

  test('a row with no detail is not an error', async () => {
    // Every ESPN fixture on the site is this row, which is most of them.
    for (const raw of [null, undefined, '', 'not json', '{}', '[]']) {
      expect(setScoreOf(event(raw))).toBe(null);
    }
  });

  test('another sport’s detail is left to another renderer', async () => {
    // The column is not tennis-shaped on purpose, so the payload names its own
    // kind rather than the renderer inferring one from the league.
    expect(setScoreOf(event({ kind: 'cricket', games: [[1], [2]] }))).toBe(null);
  });

  test('a malformed grid is refused rather than half-drawn', async () => {
    expect(setScoreOf(event({ kind: 'tennis', games: [[6, 4]] }))).toBe(null);
    expect(setScoreOf(event({ kind: 'tennis', games: [[6, 4], 'x'] }))).toBe(null);
    // Not started: two empty per-set lists. A board of dashes reads as broken.
    expect(setScoreOf(event({ kind: 'tennis', games: [[], []] }))).toBe(null);
  });
});

describe('the compact score on a list row', () => {
  test('shows the games in every set, and the points while it is live', async () => {
    const out = await render(SetScore({ event: event(live) }));
    expect(out).toContain('7-6 4-6 5-1');
    expect(out).toContain('40-AD');
  });

  test('a finished match shows the result and no points', async () => {
    const done = { ...live, points: null, serving: null };
    const out = await render(SetScore({ event: event(done) }));
    expect(out).toContain('7-6 4-6 5-1');
    expect(out).not.toContain('AD');
  });

  test('a tiebreak is labelled', async () => {
    const tb = { ...live, points: ['6', '5'], tiebreak: true };
    expect(await render(SetScore({ event: event(tb) }))).toContain('TB ');
  });

  test('a set only one side has a number for is not yet a scoreline', async () => {
    // The provider writes the two sides independently, so a poll can land between
    // them. Half a set reads as a typo; leaving it out until both arrive does not.
    const mid = {
      ...live,
      games: [
        [7, 4, 5],
        [6, 6],
      ],
      points: null,
      serving: null,
    };
    const out = await render(SetScore({ event: event(mid) }));
    expect(out).toContain('7-6 4-6');
    expect(out).not.toContain('5-');
  });

  test('renders nothing at all for a fixture with no detail', async () => {
    expect(SetScore({ event: event(null) })).toBe(null);
  });
});
