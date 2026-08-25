import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * "tipoffwatch isn't updating its live feeds on the sports page."
 *
 * It was not, and the reason was not in this codebase: the metered residential
 * proxy every ESPN request goes through hit its plan's bandwidth cap on
 * 2026-08-24 and answered `402 Bandwidth limit reached` to everything for
 * sixteen hours.
 *
 * What IS this codebase's fault is that none of it showed. The score tick ran on
 * time all night, caught each failure, counted it and carried on; the page went
 * on rendering twenty-five fixtures as in progress at the minute they had
 * reached when the money ran out. A frozen score is still a score, so from the
 * outside the site looked live and was lying.
 *
 * Two defects, one per direction:
 *   1. `state = 'in'` was treated as "this game is on". It only means nothing
 *      ever said otherwise, and nothing could, because nothing could be fetched.
 *   2. A proxy that fails as a BILLING account took the whole feed down with it,
 *      even though the same request went straight through unproxied.
 */

let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
  await db.exec(`
    insert into leagues (id, provider, provider_key, sport, slug, name, active, priority)
    values (1, 'espn', 'soccer/ita.1', 'soccer', 'serie-a', 'Italian Serie A', true, 1),
           (2, 'espn', 'basketball/nba', 'basketball', 'nba', 'NBA', true, 2);
    insert into teams (id, league_id, provider, provider_key, slug, name, display_name)
    values (10, 1, 'espn', 'bol', 'bologna', 'Bologna', 'Bologna'),
           (11, 1, 'espn', 'laz', 'lazio', 'Lazio', 'Lazio'),
           (12, 2, 'espn', 'lal', 'lakers', 'Lakers', 'Lakers'),
           (13, 2, 'espn', 'bos', 'celtics', 'Celtics', 'Celtics');
  `);
});

/** state, and how long ago the score tick last touched the row. */
const putEvent = async (id, leagueId, home, away, state, staleMinutes, startsInHours = -1) =>
  db.query(
    `insert into events (id, provider, provider_key, league_id, starts_at, state, name,
                         home_team_id, away_team_id, time_known, updated_at)
     values ($1,'espn',$2,$3, now() + ($4 || ' hours')::interval, $5, $6, $7, $8, true,
             now() - ($9 || ' minutes')::interval)
     on conflict (id) do update set state = excluded.state, updated_at = excluded.updated_at`,
    [
      id,
      `k${id}`,
      leagueId,
      String(startsInHours),
      state,
      `e${id}`,
      home,
      away,
      String(staleMinutes),
    ],
  );

const LIVE = `
  select e.id from events e join leagues l on l.id = e.league_id
  where e.state = 'in' and e.updated_at > now() - interval '30 minutes'
    and ($1::text is null or l.sport = $1)
    and ($2::bigint is null or e.league_id = $2)
    and ($3::bigint is null or $3::bigint in (e.home_team_id, e.away_team_id))
  order by l.priority, e.starts_at`;

const live = async (sport = null, leagueId = null, teamId = null) =>
  (await db.query(LIVE, [sport, leagueId, teamId])).rows.map((r) => Number(r.id));

describe('what counts as live', () => {
  test('a fixture the score tick is still touching is live', async () => {
    await putEvent(1, 1, 10, 11, 'in', 0);
    expect(await live()).toContain(1);
  });

  /*
   * The reported bug, exactly. These twenty-five sat at "43'" for sixteen hours
   * because nothing could contradict them.
   */
  test('a fixture frozen since yesterday is not', async () => {
    await putEvent(2, 1, 10, 11, 'in', 16 * 60);
    expect(await live()).not.toContain(2);
  });

  test('a single missed pass does not empty the scoreboard', async () => {
    // The tick runs every 60s; the gate is 30 minutes precisely so one failure,
    // or one league being slow, does not read as the feed being down.
    await putEvent(3, 1, 10, 11, 'in', 5);
    expect(await live()).toContain(3);
  });

  test('the stalled ones are still countable, for the page to explain itself', async () => {
    const { rows } = await db.query(
      `select count(*)::int as n from events
       where state = 'in' and updated_at <= now() - interval '30 minutes'`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('live at every drill-down level', () => {
  beforeAll(async () => {
    await putEvent(20, 1, 10, 11, 'in', 1); // Serie A, Bologna v Lazio
    await putEvent(21, 2, 12, 13, 'in', 1); // NBA, Lakers v Celtics
  });

  test('by sport', async () => {
    expect(await live('soccer')).toContain(20);
    expect(await live('soccer')).not.toContain(21);
  });

  test('by league', async () => {
    expect(await live(null, 2)).toEqual([21]);
  });

  test('by team, from either side of the fixture', async () => {
    expect(await live(null, null, 12)).toEqual([21]); // home
    expect(await live(null, null, 13)).toEqual([21]); // away
  });

  test('and unscoped still returns everything', async () => {
    const all = await live();
    expect(all).toContain(20);
    expect(all).toContain(21);
  });
});

/* ------------------------------------------------------- the proxy breaker -- */

describe('a proxy that runs out of money', () => {
  const WINDOW = {
    providerKey: 'soccer/ita.1',
    from: new Date('2026-08-24T00:00:00Z'),
    to: new Date('2026-08-25T00:00:00Z'),
  };
  const realFetch = globalThis.fetch;
  const realProxy = process.env.SPORTS_PROXY_URL;
  afterEach(() => {
    globalThis.fetch = realFetch;
    // Restore rather than delete: another file in this process may rely on it,
    // and bun:test shares one process across every test file.
    if (realProxy === undefined) delete process.env.SPORTS_PROXY_URL;
    else process.env.SPORTS_PROXY_URL = realProxy;
  });

  const load = async () => {
    process.env.SPORTS_PROXY_URL = 'http://user:pass@proxy.example:80';
    // Fresh module each time so the breaker state does not leak between tests --
    // bun:test runs every file in one process.
    const mod = await import(`../packages/sports/src/espn.js?t=${Math.random()}`);
    mod.resetProxyBreaker?.();
    return mod;
  };

  test('402 falls back to a direct request rather than failing', async () => {
    const calls = [];
    globalThis.fetch = async (_url, opts) => {
      calls.push(opts?.proxy ? 'proxy' : 'direct');
      return opts?.proxy
        ? new Response('Bandwidth limit reached. Please upgrade to continue using the proxy.', {
            status: 402,
          })
        : new Response(JSON.stringify({ events: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    };
    const espn = await load();
    // Any exported call that goes through getJson will do; the schedule fetch is
    // the one the live tick uses.
    await espn.fetchSchedule(WINDOW);
    expect(calls[0]).toBe('proxy');
    expect(calls).toContain('direct');
  });

  test('and stops paying for the doomed round trip after the first one', async () => {
    // Sequential calls here, which is the property being pinned. Concurrent ones
    // all pass the check before the first 402 lands -- see the note in espn.js.
    const calls = [];
    globalThis.fetch = async (_url, opts) => {
      calls.push(opts?.proxy ? 'proxy' : 'direct');
      return opts?.proxy
        ? new Response('Bandwidth limit reached.', { status: 402 })
        : new Response(JSON.stringify({ events: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    };
    const espn = await load();
    await espn.fetchSchedule(WINDOW);
    await espn.fetchSchedule(WINDOW);
    await espn.fetchSchedule(WINDOW);
    // One probe, then straight out for the cooldown. Without the breaker this
    // is one wasted proxied request per fixture refresh, once a minute, forever.
    expect(calls.filter((c) => c === 'proxy')).toHaveLength(1);
  });

  /*
   * The distinction the whole design turns on. 403 is ESPN refusing the proxy's
   * exit IP, and a datacenter address fares strictly worse -- retrying direct
   * would burn a round trip to be blocked again. A blanket fallback was tried
   * once before and reverted for exactly this.
   */
  test('a 403 from ESPN does not trigger the fallback', async () => {
    const calls = [];
    globalThis.fetch = async (_url, opts) => {
      calls.push(opts?.proxy ? 'proxy' : 'direct');
      return new Response('Access Denied', { status: 403 });
    };
    const espn = await load();
    // It surfaces as a failure, which is right: the caller counts it and the next
    // pass tries again. What it must NOT do is spend a second request going direct.
    await expect(espn.fetchSchedule(WINDOW)).rejects.toThrow('403');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).not.toContain('direct');
  });
});

describe('the pages that carry it', () => {
  const pages = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );
  const app = readFileSync(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');

  test('one section component, not four copies', () => {
    expect(pages).toContain('export const LiveSection');
    // Every level renders it, including the category index it was lifted from.
    expect(pages.match(/<LiveSection/g)?.length).toBeGreaterThanOrEqual(8);
  });

  test('every drill-down route asks for it', () => {
    for (const marker of ['sport })', 'leagueId: league.id })', 'teamId: team.id })']) {
      expect(app).toContain(`q.liveNowCount({ ${marker.replace(' })', '')} })`);
    }
  });

  /*
   * The third state. Without it an empty list means both "nothing is on" and "we
   * cannot currently tell", and those were indistinguishable for sixteen hours.
   */
  test('an empty list can say the feed is down rather than that nothing is on', () => {
    expect(app).toContain('q.stalledLiveCount()');
    expect(pages).toContain('Scores are not updating at the moment');
  });
});
