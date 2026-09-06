import { describe, expect, test } from 'bun:test';
import { settleOdds } from '../apps/web/src/views/components.jsx';
import * as espn from '../packages/sports/src/espn.js';

/*
 * Shapes copied from live ESPN responses on 2026-09-06. Trimmed, but the KEYS and
 * their nesting are verbatim -- the whole risk in this feature is that the provider
 * puts the same fact in two different places depending on the sport, and a fixture
 * rewritten into one tidy shape would test the tidying rather than the parsing.
 */

/** NFL scoreboard: moneyline under `moneyline.<side>.close.odds`, as a string. */
const nflOdds = [
  {
    provider: { id: '100', name: 'DraftKings', priority: 1 },
    details: 'SEA -3.5',
    overUnder: 44.5,
    spread: -3.5,
    awayTeamOdds: { favorite: false, underdog: true, team: { abbreviation: 'NE' } },
    homeTeamOdds: { favorite: true, underdog: false, team: { abbreviation: 'SEA' } },
    moneyline: {
      displayName: 'Moneyline',
      home: { close: { odds: '-185' }, open: { odds: '-175' } },
      away: { close: { odds: '154' }, open: { odds: '148' } },
    },
  },
];

/** pickcenter: moneyline under `<side>TeamOdds.moneyLine`, as a number. */
const mlbPickcenter = [
  {
    provider: { id: '100', name: 'DraftKings', priority: 1 },
    details: 'CHC -126',
    overUnder: 8.5,
    spread: 1.5,
    awayTeamOdds: { favorite: true, underdog: false, moneyLine: -126, teamId: '16' },
    homeTeamOdds: { favorite: false, underdog: true, moneyLine: 105, teamId: '28' },
  },
];

describe('oddsFromCompetition', () => {
  test('reads the scoreboard container, including the moneyline nested under close', () => {
    const line = espn.oddsFromCompetition({ odds: nflOdds }, { state: 'pre' });
    expect(line).toMatchObject({
      provider: 'DraftKings',
      details: 'SEA -3.5',
      spread: -3.5,
      overUnder: 44.5,
      favorite: 'home',
      homeMoneyline: -185,
      awayMoneyline: 154,
      capturedState: 'pre',
    });
  });

  test('reads the pickcenter container, where the moneyline is a plain number', () => {
    const line = espn.oddsFromCompetition({ odds: mlbPickcenter }, { state: 'post' });
    expect(line).toMatchObject({
      details: 'CHC -126',
      favorite: 'away',
      homeMoneyline: 105,
      awayMoneyline: -126,
      capturedState: 'post',
    });
  });

  /*
   * The provider stops publishing a line at kickoff and returns nothing in its
   * place. Both spellings of "nothing" are here because soccer uses the second one
   * and it is the one that looks non-empty: a list whose only entry is null.
   */
  test('a finished game has no line, in either spelling of empty', () => {
    expect(espn.oddsFromCompetition({ odds: null })).toBeNull();
    expect(espn.oddsFromCompetition({ odds: [] })).toBeNull();
    expect(espn.oddsFromCompetition({ odds: [null] })).toBeNull();
    expect(espn.oddsFromCompetition({})).toBeNull();
  });

  /*
   * A book entry carrying no actual price must not be stored, because the upsert
   * coalesces: a content-free row would satisfy the coalesce and lock out the real
   * line arriving on the next pass.
   */
  test('an entry with no price at all is treated as no line', () => {
    const empty = [{ provider: { name: 'DraftKings' }, awayTeamOdds: {}, homeTeamOdds: {} }];
    expect(espn.oddsFromCompetition({ odds: empty })).toBeNull();
  });

  /*
   * After settlement the book quotes the result rather than going quiet. Printing
   * "-100000" on a recap is worse than printing no moneyline, and a genuine
   * pre-game price never reaches that magnitude.
   */
  test('a settled, absurd moneyline is dropped rather than shown', () => {
    const settled = [
      {
        provider: { name: 'DraftKings' },
        details: 'USC -37.5',
        spread: -37.5,
        overUnder: 61.5,
        homeTeamOdds: { favorite: true, moneyLine: -100000 },
        awayTeamOdds: { underdog: true, moneyLine: 5000 },
      },
    ];
    const line = espn.oddsFromCompetition({ odds: settled }, { state: 'post' });
    expect(line.homeMoneyline).toBeNull();
    // The spread and total survive, so the recap still has a line to show.
    expect(line.details).toBe('USC -37.5');
    expect(line.spread).toBe(-37.5);
  });

  test('soccer carries a draw price and no favourite', () => {
    const threeWay = [
      {
        provider: { name: 'DraftKings' },
        details: 'MAN +110',
        overUnder: 2.5,
        awayTeamOdds: { moneyLine: 110 },
        homeTeamOdds: { moneyLine: 235 },
        drawOdds: { moneyLine: 275 },
      },
    ];
    const line = espn.oddsFromCompetition({ odds: threeWay });
    expect(line.drawMoneyline).toBe(275);
    expect(line.favorite).toBeNull();
  });
});

/* ----------------------------------------------------------------- recap --- */

const summary = ({ teams = [], linescores = [[], []], format, ...rest } = {}) => ({
  format: format ?? { regulation: { periods: 4, displayName: 'Quarter' } },
  boxscore: { teams },
  header: {
    competitions: [
      {
        competitors: [
          { homeAway: 'away', team: { id: '1' }, linescores: linescores[0] },
          { homeAway: 'home', team: { id: '2' }, linescores: linescores[1] },
        ],
      },
    ],
  },
  ...rest,
});

const cells = (...vals) => vals.map((v) => ({ displayValue: String(v) }));

describe('recapFromSummary', () => {
  test('linescores carry the provider’s own name for a period', () => {
    const r = espn.recapFromSummary(
      summary({
        format: { regulation: { periods: 9, displayName: 'Inning' } },
        linescores: [cells(0, 0, 3), cells(0, 2, 1)],
      }),
    );
    expect(r.linescores.periodLabel).toBe('Inning');
    expect(r.linescores.away).toEqual(['0', '0', '3']);
    expect(r.linescores.labels).toEqual(['1', '2', '3']);
  });

  /*
   * Rugby league is played in two halves and returns four columns, the last two
   * scoreless. Left alone the recap invites the reader to wonder what happened in
   * the third half.
   */
  test('scoreless periods padded past regulation are dropped', () => {
    const r = espn.recapFromSummary(
      summary({
        format: { regulation: { periods: 2, displayName: 'Half' } },
        linescores: [cells(10, 34, 0, 0), cells(10, 20, 0, 0)],
      }),
    );
    expect(r.linescores.away).toEqual(['10', '34']);
    expect(r.linescores.home).toEqual(['10', '20']);
  });

  /* Extra time is scored, so it is not padding and must survive. */
  test('a scored period past regulation is kept', () => {
    const r = espn.recapFromSummary(
      summary({
        format: { regulation: { periods: 4, displayName: 'Quarter' } },
        linescores: [cells(7, 7, 0, 3, 6), cells(7, 7, 3, 0, 3)],
      }),
    );
    expect(r.linescores.away).toHaveLength(5);
  });

  /* A scoreless quarter INSIDE regulation is a fact about the game. */
  test('a scoreless period inside regulation is kept', () => {
    const r = espn.recapFromSummary({
      ...summary({ linescores: [cells(7, 0, 0, 3), cells(0, 10, 7, 0)] }),
    });
    expect(r.linescores.away).toEqual(['7', '0', '0', '3']);
  });

  test('team stats read from the flat container', () => {
    const flat = (v) => [{ name: 'firstDowns', label: '1st Downs', displayValue: v }];
    const r = espn.recapFromSummary(
      summary({
        teams: [
          { homeAway: 'home', statistics: flat('29') },
          { homeAway: 'away', statistics: flat('19') },
        ],
      }),
    );
    expect(r.teamStats).toEqual([{ group: null, label: '1st Downs', home: '29', away: '19' }]);
  });

  /*
   * Baseball and rugby league nest their stats a level down. Reading only the flat
   * container -- the obvious one -- yields an empty table for those sports, which
   * is the same trap play-by-play hit with `plays` against `drives`.
   */
  test('team stats read from the grouped container too', () => {
    const grouped = (h) => [
      {
        name: 'batting',
        displayName: 'Batting',
        stats: [{ displayName: 'Hits', displayValue: h }],
      },
    ];
    const r = espn.recapFromSummary(
      summary({
        teams: [
          { homeAway: 'home', statistics: grouped('6') },
          { homeAway: 'away', statistics: grouped('13') },
        ],
      }),
    );
    expect(r.teamStats).toEqual([{ group: 'Batting', label: 'Hits', home: '6', away: '13' }]);
  });

  /*
   * A stat neither side recorded is a stat the sport does not use, not a
   * comparison. Rugby league returns the whole of rugby union's card at 0-0.
   */
  test('a stat both sides recorded as zero is dropped', () => {
    const stats = (mauls) => [
      { name: 'maulsTotal', label: 'Mauls Total', displayValue: mauls },
      { name: 'tries', label: 'Tries', displayValue: '4' },
    ];
    const r = espn.recapFromSummary(
      summary({
        teams: [
          { homeAway: 'home', statistics: stats('0') },
          { homeAway: 'away', statistics: stats('0') },
        ],
      }),
    );
    expect(r.teamStats.map((s) => s.label)).toEqual(['Tries']);
  });

  test('season bookkeeping is not a box score row', () => {
    const stats = [
      { name: 'gamesPlayed', label: 'Games Played', displayValue: '1' },
      { name: 'isQualified', label: 'Is Qualified', displayValue: '1' },
      { name: 'hits', label: 'Hits', displayValue: '13' },
    ];
    const r = espn.recapFromSummary(
      summary({
        teams: [
          { homeAway: 'home', statistics: stats },
          { homeAway: 'away', statistics: stats },
        ],
      }),
    );
    expect(r.teamStats.map((s) => s.label)).toEqual(['Hits']);
  });

  /*
   * A flat slice put forty rows of Batting on a baseball box score and not one
   * line of Pitching, which is a strange thing for a baseball box score to omit.
   */
  test('the row cap takes from every group rather than filling from the first', () => {
    const many = (prefix, n) =>
      Array.from({ length: n }, (_, i) => ({
        displayName: `${prefix}${i}`,
        displayValue: String(i + 1),
      }));
    const grouped = [
      { displayName: 'Batting', stats: many('b', 40) },
      { displayName: 'Pitching', stats: many('p', 40) },
    ];
    const r = espn.recapFromSummary(
      summary({
        teams: [
          { homeAway: 'home', statistics: grouped },
          { homeAway: 'away', statistics: grouped },
        ],
      }),
    );
    expect(r.teamStats.some((s) => s.group === 'Pitching')).toBe(true);
    expect(r.teamStats.some((s) => s.group === 'Batting')).toBe(true);
  });

  test('the wire recap keeps its headline and loses the stripped dateline', () => {
    const r = espn.recapFromSummary(
      summary({
        article: {
          headline: 'Conforto homers to lead the Cubs past the Marlins',
          description: '— Michael Conforto homered and singled.',
          source: 'AP',
          published: '2026-09-05T23:53:27Z',
        },
      }),
    );
    expect(r.article.summary.startsWith('Michael')).toBe(true);
    expect(r.article.source).toBe('AP');
  });

  /* Four of the seven sports sampled report attendance as 0 when they mean "not
     reported", and "Attendance 0" under a sold-out final is a worse answer. */
  test('an attendance of zero is not reported at all', () => {
    const zero = espn.recapFromSummary(summary({ gameInfo: { attendance: 0 } }));
    expect(zero?.attendance).toBeUndefined();
    const real = espn.recapFromSummary(summary({ gameInfo: { attendance: 51144 } }));
    expect(real.attendance).toBe(51144);
  });

  /* The closing line survives in pickcenter after `odds` has emptied, and gets
     marked `post` so the page can honestly call it a closing line. */
  test('the closing line is taken from pickcenter, not from the empty odds list', () => {
    const r = espn.recapFromSummary(summary({ odds: [], pickcenter: mlbPickcenter }));
    expect(r.odds.details).toBe('CHC -126');
    expect(r.odds.capturedState).toBe('post');
  });

  test('a summary with nothing in it yields no recap rather than an empty one', () => {
    expect(espn.recapFromSummary(summary())).toBeNull();
    expect(espn.recapFromSummary(null)).toBeNull();
  });
});

/* --------------------------------------------------------------- settling --- */

describe('settleOdds', () => {
  /*
   * `spread` is the HOME side's number in every sport ESPN prices, which the
   * `details` string does not tell you -- it names whichever side is favoured. Both
   * of these are real finished games, checked against their real results.
   */
  test('a big favourite winning small does not cover', () => {
    // USC (home) beat San Jose State 42-26 as a 37.5-point favourite.
    const out = settleOdds({ home_score: 42, away_score: 26 }, { spread: -37.5, overUnder: 61.5 });
    expect(out.ats).toBe('away');
    expect(out.total).toBe('over');
    expect(out.points).toBe(68);
  });

  test('an underdog losing narrowly covers', () => {
    // The Marlins (home) lost 5-6 on a +1.5 run line.
    const out = settleOdds({ home_score: 5, away_score: 6 }, { spread: 1.5, overUnder: 8.5 });
    expect(out.ats).toBe('home');
    expect(out.total).toBe('over');
  });

  test('landing exactly on the number is a push, not a loss', () => {
    const out = settleOdds({ home_score: 24, away_score: 21 }, { spread: -3, overUnder: 45 });
    expect(out.ats).toBe('push');
    expect(out.total).toBe('push');
  });

  test('a three-way price with no spread settles only the total', () => {
    const out = settleOdds({ home_score: 2, away_score: 1 }, { spread: null, overUnder: 2.5 });
    expect(out.ats).toBeUndefined();
    expect(out.total).toBe('over');
  });

  test('nothing is claimed without a score or without a line', () => {
    expect(settleOdds({ home_score: null, away_score: 3 }, { spread: -3 })).toBeNull();
    expect(settleOdds({ home_score: 1, away_score: 0 }, null)).toBeNull();
  });
});
