import { describe, expect, test } from 'bun:test';
import * as espn from '../packages/sports/src/espn.js';

/** A trimmed real ESPN payload -- shape copied from a live scoreboard response. */
const sample = {
  id: '401873272',
  date: '2026-08-13T23:00Z',
  name: 'Detroit Lions at Cincinnati Bengals',
  shortName: 'DET @ CIN',
  status: { type: { state: 'post' } },
  competitions: [
    {
      status: { type: { state: 'post', shortDetail: 'Final' } },
      venue: { fullName: 'Paycor Stadium' },
      competitors: [
        {
          homeAway: 'home',
          score: '17',
          team: {
            id: '4',
            displayName: 'Cincinnati Bengals',
            name: 'Bengals',
            abbreviation: 'CIN',
            logo: 'https://x/cin.png',
          },
        },
        {
          homeAway: 'away',
          score: '20',
          team: {
            id: '8',
            displayName: 'Detroit Lions',
            name: 'Lions',
            abbreviation: 'DET',
            logo: 'https://x/det.png',
          },
        },
      ],
    },
  ],
};

describe('espn adapter', () => {
  test('slug rule keeps dot and underscore variants apart', () => {
    // ESPN really does ship both fifa.intercontinental_cup and
    // fifa.intercontinental.cup; folding them together violates the unique index.
    const slug = (sport, key) => `${sport}-${key}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    expect(slug('soccer', 'fifa.intercontinental_cup')).not.toBe(
      slug('soccer', 'fifa.intercontinental.cup'),
    );
  });

  test('live catalogue has no duplicate slugs or provider keys', async () => {
    const cat = await espn.listLeagues();
    expect(cat.length).toBeGreaterThan(300);
    expect(new Set(cat.map((c) => c.slug)).size).toBe(cat.length);
    expect(new Set(cat.map((c) => c.provider_key)).size).toBe(cat.length);
  }, 60000);

  test('fetchSchedule normalises a real league', async () => {
    const { league, events: evs } = await espn.fetchSchedule({
      providerKey: 'soccer/eng.1',
      from: new Date(),
      to: new Date(Date.now() + 21 * 86400000),
    });
    expect(Array.isArray(evs)).toBe(true);
    // The catalogue only knows the slug; the real name has to come from here or
    // every league renders as "eng.1".
    expect(league.name).toBe('English Premier League');
    expect(league.logoUrl).toContain('http');
    for (const e of evs) {
      expect(e.providerKey).toBeTruthy();
      expect(Number.isNaN(+e.startsAt)).toBe(false);
      expect(['pre', 'in', 'post']).toContain(e.state);
    }
  }, 40000);
});

describe('event normalisation', () => {
  test('reads scores, venue and both sides from a finished game', async () => {
    // normaliseEvent is internal; exercise it through the public shape by stubbing
    // fetch for one call.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ events: [sample] }), { status: 200 });
    try {
      const {
        events: [e],
      } = await espn.fetchSchedule({
        providerKey: 'football/nfl',
        from: new Date(),
        to: new Date(Date.now() + 86400000),
      });
      expect(e.state).toBe('post');
      expect(e.venue).toBe('Paycor Stadium');
      expect(e.home.displayName).toBe('Cincinnati Bengals');
      expect(e.away.displayName).toBe('Detroit Lions');
      expect(e.homeScore).toBe(17);
      expect(e.awayScore).toBe(20);
      expect(e.providerKey).toBe('football/nfl/401873272');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('an individual sport with no competitors still yields an event', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              id: '99',
              date: '2026-08-21T10:30Z',
              name: 'Heineken Dutch GP',
              status: { type: { state: 'pre' } },
              competitions: [{ status: { type: { state: 'pre' } }, competitors: [] }],
            },
          ],
        }),
        { status: 200 },
      );
    try {
      const {
        events: [e],
      } = await espn.fetchSchedule({
        providerKey: 'racing/f1',
        from: new Date(),
        to: new Date(Date.now() + 86400000),
      });
      expect(e.home).toBeNull();
      expect(e.away).toBeNull();
      expect(e.name).toBe('Heineken Dutch GP');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/**
 * Tennis, where a scoreboard entry is a fortnight rather than a fixture.
 *
 * Read as a team sport a tournament has no `competitions` at all, so every one
 * normalised to null and the sport stored nothing: two leagues, no players, "No
 * fixtures scheduled" all season.
 */
describe('tennis tournaments', () => {
  /** A trimmed tournament: one drawn match, one still TBD, in two draws. */
  const tournament = {
    id: '718-2026',
    date: '2026-08-11T04:00Z',
    name: 'Cincinnati Open',
    status: { type: { state: 'post' } },
    groupings: [
      {
        grouping: { slug: 'mens-singles' },
        competitions: [
          {
            id: '184414',
            date: '2026-08-11T16:05Z',
            status: { type: { state: 'post', shortDetail: 'Final' } },
            venue: { fullName: 'Cincinnati, USA', court: 'Court 9' },
            competitors: [
              {
                id: '4030',
                type: 'athlete',
                order: 2,
                athlete: {
                  displayName: 'Dane Sweeny',
                  shortName: 'D. Sweeny',
                  flag: { href: 'https://x/aus.png' },
                },
                linescores: [{ winner: false }, { winner: true }, { winner: false }],
              },
              {
                id: '3301',
                type: 'athlete',
                order: 1,
                athlete: { displayName: "Christopher O'Connell", shortName: "C. O'Connell" },
                linescores: [{ winner: true }, { winner: false }, { winner: true }],
              },
            ],
          },
          {
            // An unfilled bracket slot: published before the draw is made.
            id: '999999',
            date: '2026-08-30T04:00Z',
            status: { type: { state: 'pre' } },
            competitors: [
              { id: '-3', order: 1, athlete: { displayName: 'TBD' } },
              { id: '-4', order: 2, athlete: { displayName: 'TBD' } },
            ],
          },
        ],
      },
      {
        grouping: { slug: 'womens-doubles' },
        competitions: [
          {
            id: '182450',
            date: '2026-08-16T15:05Z',
            status: { type: { state: 'post' } },
            competitors: [
              {
                id: '1652-3970',
                type: 'team',
                order: 2,
                homeAway: 'away',
                roster: {
                  displayName: 'Ulrikke Eikeri / Quinn Gleason',
                  shortDisplayName: 'U. Eikeri / Q. Gleason',
                  athletes: [{ flag: { href: 'https://x/nor.png' } }],
                },
                linescores: [{ winner: true }, { winner: false }, { winner: true }],
              },
              {
                id: '5000-6000',
                type: 'team',
                order: 1,
                homeAway: 'home',
                roster: { displayName: 'A Player / B Player', shortDisplayName: 'A. P / B. P' },
                linescores: [{ winner: false }, { winner: true }, { winner: false }],
              },
            ],
          },
        ],
      },
    ],
  };

  const schedule = async (providerKey) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ events: [tournament] }), { status: 200 });
    try {
      const r = await espn.fetchSchedule({
        providerKey,
        from: new Date(),
        to: new Date(Date.now() + 86400000),
      });
      return {
        ...r,
        // The tournament itself has no sides; every match has two.
        tournaments: r.events.filter((e) => !e.home && !e.away),
        matches: r.events.filter((e) => e.home && e.away),
      };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  test('a tournament fans out into its matches', async () => {
    const { matches } = await schedule('tennis/atp');
    expect(matches.length).toBe(1);

    const [m] = matches;
    expect(m.providerKey).toBe('tennis/atp/184414');
    expect(m.name).toBe("Dane Sweeny v Christopher O'Connell");
    expect(m.shortName).toBe("D. Sweeny v C. O'Connell");
    expect(m.startsAt.toISOString()).toBe('2026-08-11T16:05:00.000Z');
    expect(m.state).toBe('post');
  });

  test('the score is sets won, not games', async () => {
    // The linescores are games per set, and their sum is not a scoreline anyone
    // quotes. This match went 2-1 to O'Connell.
    const [m] = (await schedule('tennis/atp')).matches;
    expect({ away: m.awayScore, home: m.homeScore }).toEqual({ away: 1, home: 2 });
  });

  test('the tournament and the court both survive', async () => {
    const [m] = (await schedule('tennis/atp')).matches;
    expect(m.venue).toBe('Cincinnati Open');
    expect(m.venueCity).toBe('Cincinnati, USA · Court 9');
    // Neither player is at home, which the UI renders as "vs" with no role tags.
    expect(m.neutralSite).toBe(true);
  });

  test('an undrawn bracket slot is not a fixture', async () => {
    // Otherwise a slam publishes hundreds of "TBD v TBD" games months out, and TBD
    // becomes a player somebody can follow.
    const { events } = await schedule('tennis/atp');
    expect(events.some((e) => /TBD/.test(e.name))).toBe(false);
    expect(events.some((e) => e.providerKey.endsWith('/999999'))).toBe(false);
  });

  test('a doubles pair is one followable side', async () => {
    const { matches } = await schedule('tennis/wta');
    expect(matches.length).toBe(1);

    const [m] = matches;
    expect(m.providerKey).toBe('tennis/wta/182450');
    expect(m.away.name).toBe('Ulrikke Eikeri / Quinn Gleason');
    expect(m.away.providerKey).toBe('tennis/wta/1652-3970');
    expect(m.away.logoUrl).toBe('https://x/nor.png');
  });

  test('the tournament is stored too, so it exists before the draw does', async () => {
    // A draw is published a few days out, so a tournament that has not been drawn
    // fans out to nothing -- which left the US Open invisible a week ahead, inside
    // the horizon and with a date, purely because no match had names yet.
    const { tournaments } = await schedule('tennis/atp');
    expect(tournaments.length).toBe(1);

    const [t] = tournaments;
    expect(t.providerKey).toBe('tennis/atp/718-2026');
    expect(t.name).toBe('Cincinnati Open');
    expect(t.home).toBeNull();
    expect(t.away).toBeNull();
  });

  test('a combined tournament is split by draw, not stored twice', async () => {
    // Cincinnati and the slams are returned in full by BOTH tour scoreboards. Taken
    // at face value every match lands twice under two keys, with a second copy of
    // each player.
    const atp = (await schedule('tennis/atp')).matches.map((e) => e.providerKey.split('/').pop());
    const wta = (await schedule('tennis/wta')).matches.map((e) => e.providerKey.split('/').pop());
    expect(atp).toEqual(['184414']);
    expect(wta).toEqual(['182450']);
    expect(atp.filter((id) => wta.includes(id))).toEqual([]);
  });

  test('a real tour returns matches with players, not one tournament', async () => {
    const { events } = await espn.fetchSchedule({
      providerKey: 'tennis/atp',
      from: new Date(Date.now() - 6 * 3600_000),
      to: new Date(Date.now() + 14 * 86_400_000),
    });
    // Out of season this can legitimately be empty; when it is not, it must be
    // matches rather than the single tournament row the sport used to store.
    if (events.length === 0) return;

    const tournaments = events.filter((e) => !e.home && !e.away);
    const matches = events.filter((e) => e.home && e.away);

    // Both halves matter: the matches are the content, and the tournaments are what
    // a follower sees in the weeks before a draw is published.
    expect(matches.length).toBeGreaterThan(20);
    expect(tournaments.length).toBeGreaterThan(0);

    for (const e of matches) {
      expect(e.home?.providerKey).toBeTruthy();
      expect(e.away?.providerKey).toBeTruthy();
    }
    for (const e of events) expect(e.name).not.toContain('TBD');
    expect(new Set(events.map((e) => e.providerKey)).size).toBe(events.length);
  }, 60000);
});

describe('window splitting', () => {
  /** Records every dates= range the adapter asks for. */
  function recordingFetch(eventsPerCall) {
    const ranges = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (u) => {
      const m = /dates=(\d{8})-(\d{8})/.exec(String(u));
      if (m) ranges.push([m[1], m[2]]);
      const events = Array.from({ length: eventsPerCall }, (_, i) => ({
        id: `${ranges.length}-${i}`,
        date: '2026-08-25T12:00Z',
        name: 'G',
        status: { type: { state: 'pre' } },
        competitions: [{ status: { type: { state: 'pre' } }, competitors: [] }],
      }));
      return new Response(JSON.stringify({ events }), { status: 200 });
    };
    return {
      ranges,
      restore: () => {
        globalThis.fetch = real;
      },
    };
  }

  test('never requests a backwards date range', async () => {
    // The live bug: a narrow window split into `dates=20260831-20260830`, which
    // ESPN answers with a 400, so the league synced nothing at all.
    const { ranges, restore } = recordingFetch(100);
    try {
      await espn.fetchSchedule({
        providerKey: 'soccer/x.1',
        from: new Date('2026-08-30T00:00:00Z'),
        to: new Date('2026-08-31T00:00:00Z'),
      });
      expect(ranges.length).toBeGreaterThan(0);
      for (const [a, b] of ranges) expect(Number(a)).toBeLessThanOrEqual(Number(b));
    } finally {
      restore();
    }
  });

  test('still splits a wide window that comes back full', async () => {
    const { ranges, restore } = recordingFetch(100);
    try {
      await espn.fetchSchedule({
        providerKey: 'soccer/x.1',
        from: new Date('2026-08-01T00:00:00Z'),
        to: new Date('2026-08-29T00:00:00Z'),
      });
      // A capped response must still be subdivided, or a busy league silently
      // loses half its season.
      expect(ranges.length).toBeGreaterThan(1);
      for (const [a, b] of ranges) expect(Number(a)).toBeLessThanOrEqual(Number(b));
    } finally {
      restore();
    }
  });
});

describe('team rosters', () => {
  test('returns the full league, not just clubs playing this fortnight', async () => {
    // The bug: the picker listed 8 Premier League clubs because teams were only
    // discovered from fixtures inside the 14-day horizon.
    const teams = await espn.fetchTeams('soccer/eng.1');
    expect(teams.length).toBe(20);
    for (const t of teams) {
      expect(t.providerKey).toMatch(/^soccer\/eng\.1\/\d+$/);
      expect(t.displayName).toBeTruthy();
    }
    expect(teams.map((t) => t.displayName)).toContain('Arsenal');
  }, 40000);

  test('an individual sport with no teams endpoint returns empty, not an error', async () => {
    // Tennis/golf/racing 404 here; that is expected and must not fail the sweep.
    await expect(espn.fetchTeams('racing/f1')).resolves.toEqual(expect.any(Array));
  }, 40000);
});

describe('out-of-season leagues', () => {
  test('falls back to the undated scoreboard when a date window 404s', async () => {
    // Most leagues are out of season most of the year: in August the dated
    // scoreboard 404s for college basketball while the undated one returns the
    // season opener. Without the fallback the league looks broken rather than idle.
    const { events, league } = await espn.fetchSchedule({
      providerKey: 'basketball/mens-college-basketball',
      from: new Date(),
      to: new Date(Date.now() + 14 * 86400000),
    });
    expect(league?.name).toBeTruthy();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(Number.isNaN(+e.startsAt)).toBe(false);
  }, 45000);

  test('an out-of-season league still has a roster to follow', async () => {
    const teams = await espn.fetchTeams('basketball/mens-college-basketball');
    expect(teams.length).toBeGreaterThan(0);
  }, 45000);
});

describe('team key scoping', () => {
  test('NFL and college football teams never share a key', async () => {
    // The bug this exists for: ESPN team ids are unique only WITHIN a league. Id 7
    // is the Denver Broncos in the NFL and the Amherst Mammoths in college
    // football, and 20 of the NFL's 32 ids collide. Keying by sport merged them, so
    // the upsert overwrote one name with the other and the NFL page rendered
    // "Cal Poly Mustangs at Houston Texans" -- a real fixture with the wrong team.
    const [nfl, college] = await Promise.all([
      espn.fetchTeams('football/nfl'),
      espn.fetchTeams('football/college-football'),
    ]);
    expect(nfl.length).toBe(32);
    expect(college.length).toBeGreaterThan(100);

    const nflKeys = new Set(nfl.map((t) => t.providerKey));
    const shared = college.filter((t) => nflKeys.has(t.providerKey));
    expect(shared).toEqual([]);

    // And the bare ids really do collide, so the scoping is load-bearing rather
    // than belt-and-braces.
    const bareNfl = new Set(nfl.map((t) => t.providerKey.split('/').pop()));
    const bareShared = college.filter((t) => bareNfl.has(t.providerKey.split('/').pop()));
    expect(bareShared.length).toBeGreaterThan(0);
  }, 60000);

  test('a fixture participant keys the same way its roster entry does', async () => {
    // If these disagree, a fixture's teams simply never resolve to the roster rows.
    const [{ events }, roster] = await Promise.all([
      espn.fetchSchedule({
        providerKey: 'football/nfl',
        from: new Date(),
        to: new Date(Date.now() + 21 * 86400000),
      }),
      espn.fetchTeams('football/nfl'),
    ]);
    const rosterKeys = new Set(roster.map((t) => t.providerKey));
    const participants = events.flatMap((e) => [e.home, e.away]).filter(Boolean);
    expect(participants.length).toBeGreaterThan(0);
    for (const p of participants) expect(p.providerKey).toMatch(/^football\/nfl\/\d+$/);
    expect(participants.some((p) => rosterKeys.has(p.providerKey))).toBe(true);
  }, 60000);
});

describe('provider access', () => {
  test('requests carry a User-Agent ESPN accepts', async () => {
    // ESPN 403s Bun's default UA with an HTML body, and fetchTeams swallows the
    // error into an empty array -- so this failed as "0 teams" with no clue why,
    // and would have quietly emptied production on the next sweep.
    const teams = await espn.fetchTeams('football/nfl');
    expect(teams.length).toBe(32);
  }, 30000);

  test('the UA is curl-prefixed and still identifies us', async () => {
    const src = await Bun.file(
      new URL('../packages/sports/src/espn.js', import.meta.url).pathname,
    ).text();
    const ua = /const USER_AGENT = '([^']+)'/.exec(src);
    expect(ua).toBeTruthy();
    // Both halves matter: the prefix clears the filter, the URL keeps us honest.
    expect(ua[1]).toMatch(/^curl\//);
    expect(ua[1]).toContain('tipoffwatch.com');
  });
});

describe('provider transport', () => {
  test('requests go through the proxy whenever one is configured', async () => {
    const src = await Bun.file(
      new URL('../packages/sports/src/espn.js', import.meta.url).pathname,
    ).text();

    // ESPN blocks datacenter egress: the identical request works from a laptop and
    // 403s from Railway, which silently took production's sync down for two hours.
    expect(src).toContain('config.sports.proxyUrl');
    expect(src).toContain('...(proxy ? { proxy } : {})');
    // Unsetting the env var is the whole off-switch; no code path should decide.
    expect(src).not.toContain('proxyOnly');
  });

  test('a live fetch still returns real data', async () => {
    const teams = await espn.fetchTeams('football/nfl');
    expect(teams.length).toBe(32);
  }, 45000);
});

/**
 * Play-by-play arrives in three different containers depending on the sport, and
 * reading only the flat one is why every football and soccer fixture rendered with
 * no action log at all: the summary fetch succeeded, `plays` was simply absent, and
 * an empty result is indistinguishable from a game that has not kicked off.
 */
describe('play log shapes', () => {
  test('football plays are nested under drives, not a top-level array', () => {
    const summary = {
      drives: {
        current: {
          plays: [{ id: '1', sequenceNumber: '15100', text: 'K.Black left tackle for 5 yards' }],
        },
        previous: [
          {
            plays: [
              {
                id: '2',
                sequenceNumber: '10200',
                text: 'CJ Donaldson 1 Yd Run',
                scoringPlay: true,
                awayScore: 0,
                homeScore: 7,
              },
            ],
          },
        ],
      },
    };

    const plays = espn.playsFromSummary(summary);
    expect(plays.length).toBe(2);
    expect(plays.map((p) => p.providerPlayId)).toEqual(['1', '2']);
    expect(plays[1].scoring).toBe(true);
    expect(plays[1].homeScore).toBe(7);
  });

  test('a finished football game drops `current` entirely', () => {
    // Reaching into drives.current unconditionally throws here, which would break
    // the sync on exactly the games whose recap is worth keeping.
    const plays = espn.playsFromSummary({
      drives: { previous: [{ plays: [{ id: '9', text: 'End of game' }] }] },
    });
    expect(plays.map((p) => p.text)).toEqual(['End of game']);
  });

  test('a drives array is read the same as a drives object', () => {
    const plays = espn.playsFromSummary({ drives: [{ plays: [{ id: '3', text: 'Punt' }] }] });
    expect(plays.length).toBe(1);
  });

  test('soccer takes its ordering from commentary, which wraps the play', () => {
    const summary = {
      commentary: [
        { sequence: 0, play: { id: '100', text: 'First Half begins.' } },
        { sequence: 5, play: { id: '101', text: 'Foul by Agustin Resch.' } },
      ],
      // Every keyEvent also appears in commentary; the ids have to collapse to one
      // row or the unique index downstream rejects the batch.
      keyEvents: [{ id: '101', text: 'Foul by Agustin Resch.', scoringPlay: false }],
    };

    const plays = espn.playsFromSummary(summary);
    expect(plays.length).toBe(2);
    expect(plays.map((p) => p.sequence)).toEqual([0, 5]);
  });

  test('a keyEvent with no commentary is still kept', () => {
    const plays = espn.playsFromSummary({
      keyEvents: [{ id: '70', text: 'Goal! Houston Dynamo FC 1.', scoringPlay: true }],
    });
    expect(plays.length).toBe(1);
    expect(plays[0].scoring).toBe(true);
    expect(plays[0].sequence).toBe(null);
  });

  test('flat plays still work, and keep the label the provider wrote', () => {
    const plays = espn.playsFromSummary({
      plays: [
        {
          id: '5',
          sequenceNumber: '4',
          text: 'Pitch 3 : Ball 1',
          period: { number: 1, displayValue: '1st Inning' },
        },
      ],
    });
    expect(plays[0].periodLabel).toBe('1st Inning');
  });

  test('a period with no label of its own is phrased from clock and number', () => {
    // Football ships period.number and a clock and no displayValue at all, so with
    // no fallback the "when" column on every NFL play renders blank.
    const [play] = espn.playsFromSummary({
      drives: {
        previous: [
          {
            plays: [
              { id: '1', text: 'Kickoff', period: { number: 1 }, clock: { displayValue: '13:43' } },
            ],
          },
        ],
      },
    });
    expect(play.periodLabel).toBe('13:43 · 1st');
    expect(play.periodNumber).toBe(1);
  });

  test('plays with no id or no text are dropped rather than stored blank', () => {
    const plays = espn.playsFromSummary({
      plays: [{ id: '1' }, { text: 'orphan' }, null, { id: '2', text: 'ok' }],
    });
    expect(plays.map((p) => p.providerPlayId)).toEqual(['2']);
  });

  test('a summary with none of the three shapes is empty, not a throw', () => {
    expect(espn.playsFromSummary({})).toEqual([]);
  });

  /**
   * Coverage across the catalogue, against the live provider.
   *
   * Six of the sixteen sports have play data, in three different containers, and the
   * mapping is not obvious from any one of them -- reading only the flat field was
   * how football and soccer shipped with no action log at all. A sport that is out
   * of season has no fixture to test and is skipped; one that has a fixture and
   * returns nothing is a real regression.
   */
  test('every sport that has play data still yields it', async () => {
    const SPORTS = {
      baseball: 'baseball/mlb',
      basketball: 'basketball/nba',
      football: 'football/nfl',
      soccer: 'soccer/eng.1',
      hockey: 'hockey/nhl',
      'australian-football': 'australian-football/afl',
    };
    // Wide enough to cross an off-season: these are whole-year lookbacks.
    const WINDOWS = ['', '?dates=20260401-20260821', '?dates=20251001-20260401'];

    const checked = {};
    for (const [sport, league] of Object.entries(SPORTS)) {
      let event = null;
      for (const w of WINDOWS) {
        const res = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/${league}/scoreboard${w}`,
          { headers: { accept: 'application/json', 'user-agent': 'curl/8.5.0' } },
        );
        if (!res.ok) continue;
        const done = ((await res.json()).events ?? []).filter((e) =>
          ['in', 'post'].includes(e?.status?.type?.state),
        );
        if (done.length) {
          event = done[done.length - 1].id;
          break;
        }
      }
      if (!event) continue; // out of season, nothing to assert
      const plays = await espn.fetchPlays(league, `${league}/${event}`);
      checked[sport] = plays.length;
    }

    // Whatever was in season must have produced a log, and something must have been.
    expect(Object.keys(checked).length).toBeGreaterThan(0);
    for (const [sport, n] of Object.entries(checked)) {
      expect({ sport, hasPlays: n > 0 }).toEqual({ sport, hasPlays: true });
    }
  }, 120000);

  test('a real finished football game yields a full play log', async () => {
    // Completed, so the response is stable -- and it is the exact case that returned
    // zero plays until drives were read.
    const plays = await espn.fetchPlays('football/college-football', 'football/cfb/401752677');
    expect(plays.length).toBeGreaterThan(100);
    expect(plays.some((p) => p.scoring)).toBe(true);
    expect(new Set(plays.map((p) => p.providerPlayId)).size).toBe(plays.length);
    for (const p of plays) expect(typeof p.text).toBe('string');
  }, 45000);
});
