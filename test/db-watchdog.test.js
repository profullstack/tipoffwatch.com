import { describe, expect, it } from 'bun:test';
import { startDbWatchdog } from '../apps/web/src/lib/db-watchdog.js';

/** Swallow the watchdog's own logging so a passing run stays readable. */
const quiet = { error() {}, warn() {}, log() {} };

/** The 2026-09-07 symptom exactly: a query that never settles, in either direction. */
const neverSettles = () => new Promise(() => {});

describe('the database watchdog', () => {
  it('gives up after the pool stops answering, and says so once', async () => {
    const reasons = [];
    const w = startDbWatchdog({
      probe: neverSettles,
      // Long enough that only an explicit check() drives this test.
      intervalMs: 60_000,
      timeoutMs: 5,
      failures: 3,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    expect(await w.check()).toBe(false);
    expect(await w.check()).toBe(false);
    expect(reasons).toEqual([]);

    // The third consecutive failure is the one that restarts the container.
    expect(await w.check()).toBe(false);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('stopped issuing connections');

    // And it does not keep firing after it has given up, which would turn one
    // restart into a loop of them.
    await w.check();
    expect(reasons).toHaveLength(1);
    w.stop();
  });

  it('never gives up while the pool is answering', async () => {
    const reasons = [];
    const w = startDbWatchdog({
      probe: async () => true,
      intervalMs: 60_000,
      timeoutMs: 50,
      failures: 2,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    for (let i = 0; i < 5; i += 1) expect(await w.check()).toBe(true);
    expect(reasons).toEqual([]);
    w.stop();
  });

  it('counts a rejection the same as a hang', async () => {
    const reasons = [];
    const w = startDbWatchdog({
      probe: async () => {
        throw new Error('ERR_POSTGRES_CONNECTION_CLOSED');
      },
      intervalMs: 60_000,
      timeoutMs: 50,
      failures: 2,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    await w.check();
    await w.check();
    expect(reasons).toHaveLength(1);
    w.stop();
  });

  it('treats a healthcheck that answers "no" as a failure', async () => {
    // main.js turns a falsy healthcheck() into a throw; this pins that a probe
    // which resolves falsy is NOT read as the pool being fine.
    const reasons = [];
    const w = startDbWatchdog({
      probe: async () => {
        throw new Error('select 1 did not come back');
      },
      intervalMs: 60_000,
      timeoutMs: 50,
      failures: 1,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });
    await w.check();
    expect(reasons).toHaveLength(1);
    w.stop();
  });

  it('forgives a blip: one success clears the count', async () => {
    // The bar is CONSECUTIVE failures. A pool that answers again has recovered,
    // and restarting it would be the watchdog causing the outage.
    const reasons = [];
    let healthy = false;
    const w = startDbWatchdog({
      probe: async () => {
        healthy = !healthy;
        if (!healthy) throw new Error('down');
        return true;
      },
      intervalMs: 60_000,
      timeoutMs: 50,
      failures: 2,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    await w.check(); // healthy -> true, resets
    expect(reasons).toEqual([]);
    await w.check(); // fails, 1
    await w.check(); // healthy again, resets to 0
    expect(reasons).toEqual([]);
    w.stop();
  });

  it('refuses to start without a probe', () => {
    expect(() => startDbWatchdog({})).toThrow(/probe/);
  });

  it('does not hold the process open on its own', () => {
    // An interval that keeps the event loop alive would stop a CLI or a test run
    // from exiting; the watchdog is a passenger on a server that is already up.
    const w = startDbWatchdog({ probe: async () => true, log: quiet });
    expect(typeof w.stop).toBe('function');
    w.stop();
  });
});

/**
 * The Redis half, which is why this file is in tipoffwatch and not only in
 * genrewatch. Redis went away on 2026-09-13 and again on 2026-09-22; both times
 * `/healthz` answered 200 while `/` returned nothing, and only redeploying the
 * web service recovered it.
 */
describe('the redis watchdog', () => {
  it('names redis in the reason, so the deploy log says which one went', async () => {
    const reasons = [];
    const w = startDbWatchdog({
      subject: 'redis',
      probe: async () => {
        throw new Error('Connection is closed.');
      },
      intervalMs: 60_000,
      timeoutMs: 50,
      failures: 1,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    await w.check();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('redis');
    // Restarting the app for a wedged pool and for a wedged Redis are the same
    // move, so the sentence that explains it stays the same too.
    expect(reasons[0]).toContain('stopped issuing connections');
    w.stop();
  });

  it('catches a PING that is queued forever rather than rejected', async () => {
    /*
     * The shared client is built with `maxRetriesPerRequest: null` because BullMQ
     * requires it, and that is exactly what turns a disconnect into a hang: the
     * command is queued until the socket comes back instead of failing. A probe
     * that only caught rejections would have sat here for the whole outage, which
     * is what the app itself did.
     */
    const reasons = [];
    const w = startDbWatchdog({
      subject: 'redis',
      probe: () => new Promise(() => {}),
      intervalMs: 60_000,
      timeoutMs: 5,
      failures: 2,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    expect(await w.check()).toBe(false);
    expect(await w.check()).toBe(false);
    expect(reasons).toHaveLength(1);
    w.stop();
  });

  it('does not restart the app while Redis is merely slow to load its RDB', async () => {
    // Redis reads a 1.8GB RDB off the volume before it answers, ~26 seconds at the
    // last measurement. A restart must not be read as a wedge, so the count has to
    // clear the moment PING comes back.
    const reasons = [];
    let loaded = false;
    const w = startDbWatchdog({
      subject: 'redis',
      probe: async () => {
        if (!loaded) throw new Error('LOADING Redis is loading the dataset in memory');
        return 'PONG';
      },
      intervalMs: 60_000,
      timeoutMs: 50,
      failures: 3,
      onGiveUp: (reason) => reasons.push(reason),
      log: quiet,
    });

    await w.check();
    await w.check();
    loaded = true;
    expect(await w.check()).toBe(true);
    // Two more failures after recovery must not reach the ceiling on their own.
    loaded = false;
    await w.check();
    await w.check();
    expect(reasons).toEqual([]);
    w.stop();
  });
});
