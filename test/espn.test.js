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
