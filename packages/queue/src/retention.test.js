import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import {
  boundedReturn,
  EVENT_STREAM_MAX_LEN,
  KEEP_COMPLETED,
  KEEP_FAILED,
  pruneQueues,
  RETURN_VALUE_MAX_BYTES,
  retention,
  streams,
} from './retention.js';

/**
 * BullMQ history in Redis, bounded.
 *
 * 2026-10-01 on dev2: bull:sync:events held 385MB in 485 entries -- about 21
 * completed events of ~18MB, each one sync-near or sync-all handing back the
 * mirror's whole `result` and `cursor`. The stream was already capped at 1,000
 * entries by #78, which is why the count alone was never the fix.
 */

const read = (f) => Bun.file(new URL(f, import.meta.url)).text();

describe('retention caps', () => {
  test('finished jobs are bounded by both age and count', () => {
    for (const keep of [KEEP_COMPLETED, KEEP_FAILED]) {
      expect(keep.age).toBeGreaterThan(0);
      expect(keep.count).toBeGreaterThan(0);
    }
    expect(retention).toEqual({ removeOnComplete: KEEP_COMPLETED, removeOnFail: KEEP_FAILED });
  });

  test('completed fan-outs outlive the window the scan dedupes them across', () => {
    // An event re-matches the scan for the whole lookback; its fo-<event>-<offset>
    // job must still be retained, or the next tick enqueues a second fan-out.
    expect(KEEP_COMPLETED.age).toBeGreaterThanOrEqual(30 * 60);
  });

  test('event streams are capped well below BullMQ’s 10,000 default', () => {
    expect(streams.events.maxLen).toBe(EVENT_STREAM_MAX_LEN);
    expect(EVENT_STREAM_MAX_LEN).toBeLessThan(10_000);
  });

  test('every Queue and Worker is built with the stream cap and every processor is bounded', async () => {
    const index = await read('./index.js');
    const workers = await read('./workers.js');
    for (const b of index.split('new Queue(').slice(1))
      expect(b.slice(0, 200)).toContain('streams');
    const built = workers.split('new Worker(').slice(1);
    expect(built.length).toBe(8);
    for (const b of built) {
      expect(b.slice(0, 1500)).toContain('streams');
      expect(b.slice(0, 80)).toContain('cap(QUEUES.');
    }
  });

  test('both entrypoints that start workers also run the retention pass', async () => {
    for (const f of ['../../../apps/web/src/main.js', '../../../apps/worker/src/main.js']) {
      const src = await read(f);
      expect(src).toContain('startWorkers()');
      expect(src).toContain('pruneHistory()');
    }
  });
});

describe('boundedReturn', () => {
  test('a small return value passes through untouched', async () => {
    const counts = { leagues: 3, events: 40, failed: 0 };
    const p = boundedReturn('sync', async () => counts, { log: () => {} });
    expect(await p({ id: '1' })).toBe(counts);
    expect(await boundedReturn('x', async () => undefined)({ id: '2' })).toBeUndefined();
  });

  test('bulk data is replaced by a summary and logged', async () => {
    const logs = [];
    const fat = { leagues: 0, mirror: { result: 'x'.repeat(RETURN_VALUE_MAX_BYTES * 2) } };
    const p = boundedReturn('sync', async () => fat, { log: (l) => logs.push(l) });
    const out = await p({ id: 'j1' });
    expect(out.oversized).toBeGreaterThan(RETURN_VALUE_MAX_BYTES);
    expect(out.keys).toEqual(['leagues', 'mirror']);
    expect(JSON.stringify(out).length).toBeLessThan(1024);
    expect(logs[0]).toContain('sync job j1 returned');
  });

  test('a processor error still fails the job', async () => {
    const p = boundedReturn('sync', async () => {
      throw new Error('upstream 503');
    });
    await expect(p({ id: '3' })).rejects.toThrow('upstream 503');
  });
});

describe('mirrorCounts', () => {
  test('keeps the counts and drops the result and cursor', async () => {
    // The sports module reads config at import; it never connects here.
    process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';
    const { mirrorCounts } = await import('../../sports/src/index.js');
    const pass = {
      requests: 201,
      leagues: 360,
      teams: 11400,
      fixtures: 5270,
      exhausted: false,
      resumed: ['fixtures:since'],
      spent: '201/2000',
      result: { items: Array.from({ length: 1000 }, (_, i) => ({ id: i })) },
      cursor: { since: '2026-10-01T00:00:00Z', 'fixtures:all': { page: 9 } },
    };
    const out = mirrorCounts(pass);
    expect(out).toEqual({
      requests: 201,
      leagues: 360,
      teams: 11400,
      fixtures: 5270,
      exhausted: false,
      resumed: ['fixtures:since'],
      spent: '201/2000',
    });
    expect(mirrorCounts({ skipped: 'a mirror pass is already running' })).toEqual({
      skipped: 'a mirror pass is already running',
    });
  });

  test('sync-near and sync-all return the counts, never the whole pass', async () => {
    const src = await read('../../sports/src/index.js');
    expect(src).not.toMatch(/broadcasts,\s*mirror\s*[,}]/);
    expect(src.match(/mirror: mirrorCounts\(mirror\)/g)?.length).toBe(2);
  });
});

// Needs a Redis: REDIS_TEST_URL=redis://... bun test. Each test owns a namespace.
const redisUrl = process.env.REDIS_TEST_URL;
describe.skipIf(!redisUrl)('retention with Redis', () => {
  let queue, connection;
  const logs = [];
  const log = (l) => logs.push(l);
  beforeEach(async () => {
    logs.length = 0;
    connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(`test-retention-${randomUUID()}`, {
      connection,
      defaultJobOptions: retention,
      streams,
    });
    await queue.waitUntilReady();
  });
  afterEach(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });

  const fillStream = async (n, field = 'x') => {
    const pipe = connection.pipeline();
    for (let i = 0; i < n; i++) pipe.xadd(queue.keys.events, '*', 'event', 'test', 'v', field);
    await pipe.exec();
  };

  test('the queue writes its stream cap into meta, where the Lua scripts read it', async () => {
    expect(await connection.hget(queue.keys.meta, 'opts.maxLenEvents')).toBe(
      String(EVENT_STREAM_MAX_LEN),
    );
  });

  test('jobs added with their own options still inherit the retention', async () => {
    const fo = await queue.add('fanout', {}, { jobId: 'fo-1-60' });
    const rep = await queue.add('sync-near', {}, { repeat: { every: 3 * 3600_000 } });
    const seed = await queue.add('sync-near', {}, { jobId: 'seed-near-x', delay: 30_000 });
    for (const j of [fo, rep, seed]) {
      expect(j.opts.removeOnComplete).toEqual(KEEP_COMPLETED);
      expect(j.opts.removeOnFail).toEqual(KEEP_FAILED);
    }
  });

  test('a backlog stream is trimmed to the cap exactly, then left alone', async () => {
    await fillStream(2600);
    await pruneQueues([queue], { log, step: 500, pauseMs: 0 });
    expect(await connection.xlen(queue.keys.events)).toBe(EVENT_STREAM_MAX_LEN);
    expect(logs.some((l) => l.includes(`pruned ${queue.name}`))).toBe(true);

    logs.length = 0;
    const [again] = await pruneQueues([queue], { log, pauseMs: 0 });
    expect(again.events.removed).toBe(0);
    expect(logs.some((l) => l.includes('pruned'))).toBe(false);
  });

  test('a stream that is huge in bytes but short in entries is emptied', async () => {
    // The sync:events shape: few entries, each one enormous.
    await fillStream(20, 'y'.repeat(64 * 1024));
    const [r] = await pruneQueues([queue], { log, maxBytes: 256 * 1024, pauseMs: 0 });
    expect(r.events.bytes).toBeGreaterThan(256 * 1024);
    expect(await connection.xlen(queue.keys.events)).toBe(0);
  });

  test('completed jobs past their age are removed, fresh ones kept', async () => {
    const worker = new Worker(queue.name, null, { connection, autorun: false, streams });
    try {
      for (const id of ['old-1', 'old-2', 'fresh']) {
        await queue.add('t', {}, { jobId: id });
        const job = await worker.getNextJob('tok', { block: false });
        await job.moveToCompleted('ok', 'tok', false);
      }
      const old = Date.now() - (KEEP_COMPLETED.age + 60) * 1000;
      for (const id of ['old-1', 'old-2']) {
        await connection.zadd(queue.keys.completed, old, id);
        await connection.hset(`${queue.keys['']}${id}`, 'finishedOn', old, 'processedOn', old);
      }
      const [r] = await pruneQueues([queue], { log, pauseMs: 0 });
      expect(r.completed).toBe(2);
      expect(await queue.getCompletedCount()).toBe(1);
      expect(await queue.getJob('fresh')).toBeTruthy();
    } finally {
      await worker.close();
    }
  });

  test('a failing queue is reported, not thrown', async () => {
    const broken = { name: 'broken', client: Promise.reject(new Error('no redis')) };
    broken.client.catch(() => {});
    const report = await pruneQueues([broken], { log });
    expect(report).toEqual([]);
    expect(logs.some((l) => l.includes('prune broken failed: no redis'))).toBe(true);
  });
});
