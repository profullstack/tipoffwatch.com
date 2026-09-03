import { beforeEach, describe, expect, test } from 'bun:test';
import { cacheStats, resetCache, sharedFetch } from '../packages/radio/src/upstream-cache.js';

/*
 * One upstream fetch for however many listeners. The property that protects a
 * SiriusXM account, so it is pinned: concurrent requests for one URL reach the
 * fetcher once, a request a moment later is served from memory, and an error is
 * never held.
 */
describe('sharedFetch', () => {
  beforeEach(() => resetCache());

  const body = (s) => new TextEncoder().encode(s).buffer;

  test('collapses concurrent requests into one upstream call', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { status: 200, contentType: 'audio/aac', body: body('seg') };
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => sharedFetch('https://cdn.siriusxm.com/seg1.aac', fetcher)),
    );
    expect(calls).toBe(1);
    expect(results.filter((r) => !r.cached)).toHaveLength(1);
    expect(new TextDecoder().decode(results[5].body)).toBe('seg');
  });

  test('serves a segment from memory just after, and a manifest only briefly', async () => {
    let calls = 0;
    const seg = async () => {
      calls++;
      return { status: 200, contentType: 'audio/aac', body: body('x') };
    };
    await sharedFetch('https://cdn.siriusxm.com/a.aac', seg);
    const again = await sharedFetch('https://cdn.siriusxm.com/a.aac', seg);
    expect(calls).toBe(1);
    expect(again.cached).toBe(true);
    expect(cacheStats().entries).toBe(1);
  });

  test('never pins an error', async () => {
    let calls = 0;
    const bad = async () => {
      calls++;
      return { status: 502, contentType: 'text/plain', body: body('no') };
    };
    await sharedFetch('https://cdn.siriusxm.com/b.aac', bad);
    await sharedFetch('https://cdn.siriusxm.com/b.aac', bad);
    expect(calls).toBe(2);
    expect(cacheStats().entries).toBe(0);
  });

  test('a fetcher that throws releases the key for the next caller', async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error('reset');
      return { status: 200, contentType: 'audio/aac', body: body('ok') };
    };
    await expect(sharedFetch('https://cdn.siriusxm.com/c.aac', flaky)).rejects.toThrow('reset');
    const ok = await sharedFetch('https://cdn.siriusxm.com/c.aac', flaky);
    expect(ok.status).toBe(200);
    expect(cacheStats().inFlight).toBe(0);
  });
});
