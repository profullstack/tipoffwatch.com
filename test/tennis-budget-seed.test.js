import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const { config } = await import('../packages/config/src/index.js');
const livetennis = await import('../packages/sports/src/livetennis.js');

config.sports.livetennis.apiKey = 'twjp_test';

/**
 * Knowing what has already been spent today, across a restart.
 *
 * The day's counter lives in memory, and that was a real hole rather than a
 * theoretical one: every deploy restarts the process, so the count went back to
 * zero while the provider kept counting. On a day with four deploys the adapter
 * believed it had spent nothing while the provider had it at 65 of 100 -- so the
 * guard could not have stopped us crossing the real limit, which is 429s and
 * frozen scores rather than a graceful stop.
 *
 * `/usage` reports both `today.calls` and `limits.per_day`, so the truth is one
 * request away. These are about spending that request well: once per process, never
 * fatal, and believed over our own optimism.
 */
let seen = [];
const realFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

const mock = ({ used = 0, perDay = 100, usageStatus = 200, body = null } = {}) => {
  globalThis.fetch = async (url) => {
    const path = String(url).split('/api/public/v1')[1];
    seen.push(path);
    if (path.startsWith('/usage')) {
      if (usageStatus !== 200) return new Response('{"error":"nope"}', { status: usageStatus });
      return new Response(
        JSON.stringify(body ?? { today: { calls: used }, limits: { per_day: perDay } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ data: [], meta: { has_more: false } }), { status: 200 });
  };
};

const read = () =>
  livetennis.fetchSchedule({
    providerKey: 'atp',
    from: new Date('2026-08-29T00:00:00Z'),
    to: new Date('2026-08-31T00:00:00Z'),
    log: () => {},
  });

beforeEach(() => {
  livetennis.resetBudget();
  config.sports.livetennis.dailyBudget = 95;
  seen = [];
});

describe('seeding the day from the provider', () => {
  test('a restart inherits what was already spent, instead of starting at zero', async () => {
    mock({ used: 65 });
    await read();

    // 65 the provider knew about, +1 for asking, +3 for the snapshots.
    expect(livetennis.spentToday().calls).toBe(69);
    expect(livetennis.spentToday().seeded).toBe(true);
    expect(seen[0]).toBe('/usage');
  });

  test('it asks once per process, not once per request', async () => {
    mock({ used: 10 });
    await read();
    // Deliberately NOT resetting: this is the same process asking again, which is
    // what every later sync pass is.
    await read();
    expect(seen.filter((p) => p.startsWith('/usage')).length).toBe(1);
  });

  test('a key already over the line spends nothing further', async () => {
    // The whole point. Before this, a restart at 96/95 would cheerfully spend 95
    // more and collect 429s for the rest of the day.
    mock({ used: 96 });
    const r = await read();
    expect(r.events).toEqual([]);
    expect(seen.filter((p) => !p.startsWith('/usage'))).toEqual([]);
  });

  test('the plan’s real ceiling wins over an optimistic setting', async () => {
    // A LIVETENNIS_DAILY_BUDGET above what the plan allows is not a budget, it is a
    // promise nobody is keeping.
    config.sports.livetennis.dailyBudget = 5000;
    mock({ used: 0, perDay: 100 });
    await read();
    expect(livetennis.spentToday().budget).toBe(100);
  });

  test('a lower setting than the plan is still respected', async () => {
    config.sports.livetennis.dailyBudget = 20;
    mock({ used: 0, perDay: 100 });
    await read();
    expect(livetennis.spentToday().budget).toBe(20);
  });

  test('being unable to ask is not a reason to stop working', async () => {
    // A provider that is down is not a budget problem. Falling back to counting
    // locally from zero is exactly the old behaviour, which was serviceable.
    mock({ usageStatus: 500 });
    const r = await read();
    expect(r.league.name).toBe('ATP Tour');
    expect(livetennis.spentToday().seeded).toBe(false);
    expect(seen.filter((p) => !p.startsWith('/usage')).length).toBeGreaterThan(0);
  });

  test('a failed seed is retried rather than remembered for the day', async () => {
    // The in-flight promise has to be cleared on failure, or every later request
    // awaits one settled rejection until midnight.
    mock({ usageStatus: 500 });
    await read();
    mock({ used: 40 });
    livetennis.resetBudget();
    config.sports.livetennis.dailyBudget = 95;
    await read();
    expect(livetennis.spentToday().seeded).toBe(true);
    expect(livetennis.spentToday().calls).toBe(44);
  });

  test('a nonsense answer counts the request and moves on', async () => {
    mock({ body: { nothing: 'useful' } });
    await read();
    // The ask still cost one, and the snapshots cost three.
    expect(livetennis.spentToday().calls).toBe(4);
  });

  test('concurrent first reads seed once between them', async () => {
    mock({ used: 7 });
    await Promise.all([read(), read(), read()]);
    expect(seen.filter((p) => p.startsWith('/usage')).length).toBe(1);
  });
});
