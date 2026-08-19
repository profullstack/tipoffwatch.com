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
