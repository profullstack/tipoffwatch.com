import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { EventPage, ResultsPage } = await import('../apps/web/src/views/pages.jsx');
const { EventRow, OddsPanel } = await import('../apps/web/src/views/components.jsx');

/** A component that renders nothing returns null, which has no toString. */
const render = async (node) => (node == null ? '' : (await node.toString()).toString());

/**
 * A recap in the shape recapFromSummary writes, trimmed from the real college
 * football fixture that shaped it (USC 42, San Jose State 26, 2026-09-06).
 *
 * Written out rather than fetched. The parsing of a live response is tested in
 * odds-and-recap.test.js; what is being tested here is that the page draws what it
 * is handed, and a renderer test that needs the network fails on a train.
 */
const RECAP = {
  linescores: {
    labels: ['1', '2', '3', '4'],
    periodLabel: 'Quarter',
    away: ['0', '0', '3', '23'],
    home: ['7', '21', '7', '7'],
  },
  teamStats: [
    { group: null, label: '1st Downs', home: '29', away: '19' },
    { group: null, label: 'Total Yards', home: '505', away: '336' },
  ],
  leaders: [
    {
      side: 'home',
      team: 'USC',
      category: 'Passing Yards',
      name: 'Jayden Maiava',
      line: '25/29, 286 YDS, 2 TD',
    },
  ],
  attendance: 51144,
  duration: '3:12',
  officials: ['A. Referee'],
  article: {
    headline: 'Jayden Maiava leads USC past San Jose State',
    summary: 'Jayden Maiava passed for 286 yards and two touchdowns.',
    source: 'AP',
    publishedAt: '2026-09-06T00:24:56Z',
  },
};

const CLOSING = {
  provider: 'DraftKings',
  details: 'USC -37.5',
  spread: -37.5,
  overUnder: 61.5,
  favorite: 'home',
  homeMoneyline: null,
  awayMoneyline: null,
  drawMoneyline: null,
  capturedAt: '2026-09-06T02:00:00Z',
  capturedState: 'post',
};

const OPENING = {
  provider: 'DraftKings',
  details: 'SEA -3.5',
  spread: -3.5,
  overUnder: 44.5,
  favorite: 'home',
  homeMoneyline: -185,
  awayMoneyline: 154,
  drawMoneyline: null,
  capturedAt: '2026-09-06T02:00:00Z',
  capturedState: 'pre',
};

const BASE = {
  id: 999,
  name: 'San Jose State Spartans at USC Trojans',
  short_name: 'SJSU @ USC',
  starts_at: '2026-09-06T02:30:00.000Z',
  league_id: 1,
  league_name: 'NCAA Football',
  league_slug: 'football-college-football',
  sport: 'football',
  venue: 'United Airlines Field',
  home_name: 'USC Trojans',
  away_name: 'San Jose State Spartans',
  home_slug: 'usc',
  away_slug: 'sjsu',
  neutral_site: false,
  status_detail: 'Final',
};

const finished = (over = {}) => ({
  ...BASE,
  state: 'post',
  home_score: 42,
  away_score: 26,
  recap: RECAP,
  odds: CLOSING,
  ...over,
});

// `offers` has no default on EventPage; the route always supplies it.
const page = (event) =>
  render(EventPage({ user: null, event, offers: [], plays: [], comments: [] }));

describe('a finished game', () => {
  test('draws the box score the provider gave us', async () => {
    const out = await page(finished());
    expect(out).toContain('class="linescore"');
    // The provider's own word for a period, so baseball says Inning and volleyball
    // says Set without a per-sport table here.
    expect(out).toContain('Quarter');
    expect(out).toContain('class="teamstats"');
    expect(out).toContain('Total Yards');
    expect(out).toContain('class="leaders"');
    // Already phrased by the provider; printed rather than rebuilt.
    expect(out).toContain('25/29, 286 YDS, 2 TD');
    expect(out).toContain('Jayden Maiava leads USC past San Jose State');
    expect(out).toContain('51,144 in attendance');
  });

  /* The scoreboard and the summary both carry the crowd, so the event row usually
     has it too. Printed once, not once as a headline figure and again below it. */
  test('attendance is not printed twice when the stat tile already has it', async () => {
    const out = await page(finished({ attendance: 51144 }));
    expect(out.match(/51,144/g)).toHaveLength(1);
    expect(out).not.toContain('51,144 in attendance');
  });

  /* A table wider than a phone must scroll inside its own box; the page itself
     must never scroll sideways. */
  test('wide tables are wrapped in their own scroller', async () => {
    const out = await page(finished());
    const wrappers = out.match(/class="scroll-x"/g) ?? [];
    expect(wrappers.length).toBeGreaterThanOrEqual(2);
  });

  test('calls the stored line a closing line and settles it', async () => {
    const out = await page(finished());
    expect(out).toContain('Closing line');
    expect(out).toContain('USC -37.5');
    // USC won by 16 as a 37.5-point favourite, so the underdog covered.
    expect(out).toContain('San Jose State Spartans covered.');
    expect(out).toContain('The total went over.');
  });

  /*
   * The column is jsonb and arrives parsed on one path and as a string on another.
   * A page that reads .details off a string silently draws nothing, which is the
   * failure mode this guards -- it looks like "the provider had no odds".
   */
  test('reads the line whether it arrives parsed or as a string', async () => {
    const asString = await page(finished({ odds: JSON.stringify(CLOSING), recap: null }));
    expect(asString).toContain('USC -37.5');
    const recapString = await page(finished({ recap: JSON.stringify(RECAP) }));
    expect(recapString).toContain('class="linescore"');
  });

  test('a finished game with no box score simply has no recap section', async () => {
    const out = await page(finished({ recap: null }));
    expect(out).not.toContain('class="linescore"');
    expect(out).not.toContain('>Recap<');
    // The line it does have is still shown.
    expect(out).toContain('Closing line');
  });
});

describe('a game not yet played', () => {
  const upcoming = () => ({
    ...BASE,
    state: 'pre',
    status_detail: null,
    home_score: null,
    away_score: null,
    recap: null,
    odds: OPENING,
  });

  /*
   * The stored line is a snapshot, never a live quote -- the provider stops
   * publishing one at kickoff. Presenting it as current would be the one genuinely
   * misleading thing this feature could do.
   */
  test('never calls a pre-kickoff line a closing one', async () => {
    const out = await page(upcoming());
    expect(out).toContain('The line');
    expect(out).not.toContain('Closing line');
  });

  test('claims no settlement before there is a result', async () => {
    const out = await page(upcoming());
    expect(out).not.toContain('covered.');
    expect(out).not.toContain('The total went');
  });

  test('marks the favourite on the side it belongs to, in words', async () => {
    // "USC -37.5" only identifies a team to someone who knows the abbreviation,
    // which across 354 leagues is nobody.
    const out = await page(upcoming());
    expect(out).toContain('Favourite');
    expect(out.indexOf('USC Trojans')).toBeLessThan(out.indexOf('Favourite'));
  });

  test('shows both moneylines with the sign spelled out', async () => {
    const out = await page(upcoming());
    expect(out).toContain('-185');
    expect(out).toContain('+154');
  });

  test('draws no recap section at all', async () => {
    expect(await page(upcoming())).not.toContain('>Recap<');
  });

  /*
   * Where the market opened. All 16 NFL games on the board had moved off their
   * opening number when this was measured, so a line with no movement shown is
   * usually a line missing half its story.
   */
  test('shows where the market opened when it has moved', async () => {
    const withOpen = {
      ...upcoming(),
      odds: {
        ...OPENING,
        opening: { spread: -2.5, overUnder: 46.5, homeMoneyline: -175, awayMoneyline: 148 },
      },
    };
    const out = await page(withOpen);
    expect(out).toContain('odds-move');
    expect(out).toContain('Opened at -2.5');
    expect(out).toContain('Opened at 46.5');
    expect(out).toContain('DraftKings opened this market');
  });

  /* A number that has not budged says nothing rather than repeating itself. */
  test('a number that has not moved gets no arrow', async () => {
    const unmoved = {
      ...upcoming(),
      odds: {
        ...OPENING,
        opening: {
          spread: OPENING.spread,
          overUnder: OPENING.overUnder,
          homeMoneyline: OPENING.homeMoneyline,
          awayMoneyline: OPENING.awayMoneyline,
        },
      },
    };
    expect(await page(unmoved)).not.toContain('odds-move');
  });

  /*
   * A spread that opened +1.5 and sits at -1.5 has crossed sides. Printing the
   * opening as a bare "1.5" hides exactly the movement worth showing.
   */
  test('an opening spread keeps its sign', async () => {
    const flipped = {
      ...upcoming(),
      odds: { ...OPENING, spread: -1.5, details: 'MIN -1.5', opening: { spread: 1.5 } },
    };
    expect(await page(flipped)).toContain('Opened at +1.5');
  });

  test('a line with no opening recorded draws no arrows', async () => {
    const out = await page({ ...upcoming(), odds: { ...OPENING, opening: null } });
    expect(out).not.toContain('odds-move');
    expect(out).not.toContain('opened this market');
  });
});

describe('a fixture with no line', () => {
  test('draws no panel rather than an empty one', async () => {
    const out = await page(finished({ odds: null, recap: null }));
    expect(out).not.toContain('odds-panel');
    expect(out).not.toContain('The line');
  });

  test('a row with no line draws no chip', async () => {
    const out = await render(
      EventRow({ event: { ...BASE, state: 'pre', odds: null }, showOdds: true }),
    );
    expect(out).not.toContain('odds-chip');
  });

  test('an unparseable line is treated as no line, not as a crash', async () => {
    const out = await render(OddsPanel({ event: { ...BASE, odds: '{not json' } }));
    expect(out).toBe('');
  });
});

describe('list rows', () => {
  test('the chip is opt-in, so schedules that are about time stay uncluttered', async () => {
    const event = { ...BASE, state: 'pre', odds: OPENING };
    expect(await render(EventRow({ event }))).not.toContain('odds-chip');
    expect(await render(EventRow({ event, showOdds: true }))).toContain('SEA -3.5');
  });

  test('the results page lists finished games with their line', async () => {
    const out = await render(
      ResultsPage({ user: null, events: [finished()], total: 1, sport: null, windowDays: 7 }),
    );
    expect(out).toContain('San Jose State Spartans');
    expect(out).toContain('odds-chip');
    expect(out).toContain('USC -37.5');
  });

  test('an empty results page says so rather than rendering nothing', async () => {
    const out = await render(
      ResultsPage({ user: null, events: [], total: 0, sport: null, windowDays: 7 }),
    );
    expect(out).toContain('class="empty"');
  });
});
