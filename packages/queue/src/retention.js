/**
 * How much history BullMQ keeps in Redis, in one place.
 *
 * Three things accumulate if nothing bounds them: finished job hashes (each one
 * holding its data and return value), the `completed` / `failed` sets indexing
 * them, and each queue's `events` stream. The first two are bounded per job by
 * `removeOnComplete` / `removeOnFail`; the stream is bounded per queue by
 * `streams.events.maxLen`, which BullMQ stores in the queue's meta hash when a
 * Queue is constructed.
 *
 * A count is not a size. Every `completed` event carries the processor's return
 * value, so a stream costs maxLen times whatever the fattest job hands back.
 * PR #78 capped the stream at 1,000 after the live tick's return put 15GB in one
 * key; on 2026-10-01 `bull:sync:events` still held 385MB in only 485 entries,
 * because sync-near and sync-all returned the mirror's whole `result` and
 * `cursor` (~18MB per completed event). Hence the byte ceiling and the return
 * value guard below, not just the count.
 */

/**
 * BullMQ's own default is 10,000. These are for observability -- nothing here
 * reads them back, there is no QueueEvents -- so a thousand is plenty.
 */
export const EVENT_STREAM_MAX_LEN = 1000;

export const streams = { events: { maxLen: EVENT_STREAM_MAX_LEN } };

/**
 * Completed jobs: an hour, at most 5,000 per queue.
 *
 * The hour is load-bearing, not just debugging: the reminder scan dedupes its
 * fan-outs on a retained `fo-<event>-<offset>` jobId, and an event re-matches
 * for several minutes, so a completed fan-out must outlive that window. The
 * count stays generous for the same reason -- evicting a fan-out early by count
 * would let the next scan enqueue it again -- and finished jobs are small now
 * that every processor returns counts.
 */
export const KEEP_COMPLETED = { age: 3600, count: 5000 };

/**
 * Failed jobs: a week, so a failure seen on Monday is still inspectable on
 * Friday, capped at a thousand so a tick that fails every 30 seconds cannot
 * fill Redis with stack traces. Measured 2026-10-01: at most 6 per queue. It
 * was a day with no count before.
 */
export const KEEP_FAILED = { age: 7 * 24 * 3600, count: 1000 };

export const retention = { removeOnComplete: KEEP_COMPLETED, removeOnFail: KEEP_FAILED };

/**
 * An events stream larger than this is emptied rather than trimmed by count:
 * a thousand entries is only safe while each entry is small, and a stream
 * this big means some processor returned bulk data, and those entries are
 * spread through it, so no count-based trim reaches all of them.
 */
export const EVENT_STREAM_MAX_BYTES = 32 * 1024 * 1024;

/** What a processor may hand back before it is replaced by a summary. */
export const RETURN_VALUE_MAX_BYTES = 16 * 1024;

/**
 * Wrap a processor so its return value can never be bulk data.
 *
 * BullMQ writes the return value twice -- the job hash and the `completed`
 * event -- and nothing in this app reads either back. Returning counts is the
 * rule; this is the backstop for the next time a payload slips into a return,
 * which has now happened twice (#78's live tick, then sync's `mirror`).
 */
export function boundedReturn(
  name,
  processor,
  { log = console.log, maxBytes = RETURN_VALUE_MAX_BYTES } = {},
) {
  return async (job, token) => {
    const value = await processor(job, token);
    if (value === undefined) return value;
    let bytes;
    try {
      bytes = JSON.stringify(value)?.length ?? 0;
    } catch {
      bytes = Infinity;
    }
    if (bytes <= maxBytes) return value;
    log(`[queue] ${name} job ${job?.id} returned ${bytes} bytes; storing a summary instead`);
    return {
      oversized: Number.isFinite(bytes) ? bytes : 'unserialisable',
      keys: value && typeof value === 'object' ? Object.keys(value).slice(0, 20) : typeof value,
    };
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One pass over every queue bringing what is ALREADY in Redis inside the caps
 * above. New options only govern new jobs, so without this a backlog written
 * under the old defaults stays until the stream turns over.
 *
 * Safe to run on every boot: once everything is within bounds each queue costs
 * an XLEN, a MEMORY USAGE and two ZRANGEBYSCOREs, and removes nothing. It works
 * in small steps with a pause between them so no single command holds Redis.
 * Errors are logged, never thrown: this must not stop a worker from booting.
 */
export async function pruneQueues(
  queues,
  {
    log = console.log,
    maxLen = EVENT_STREAM_MAX_LEN,
    maxBytes = EVENT_STREAM_MAX_BYTES,
    step = 500,
    pauseMs = 25,
  } = {},
) {
  const report = [];
  for (const queue of queues) {
    try {
      const r = await pruneQueue(queue, { maxLen, maxBytes, step, pauseMs });
      report.push(r);
      if (r.events.removed || r.completed || r.failed) {
        log(
          `[queue] pruned ${r.name}: events ${r.events.before} -> ${r.events.after} ` +
            `(${mb(r.events.bytes)} before), ${r.completed} completed, ${r.failed} failed`,
        );
      }
    } catch (err) {
      log(`[queue] prune ${queue.name} failed: ${err?.message ?? err}`);
    }
  }
  const removed = report.reduce((n, r) => n + r.events.removed + r.completed + r.failed, 0);
  log(`[queue] retention pass: ${report.length} queue(s), ${removed} entr(ies) removed`);
  return report;
}

async function pruneQueue(queue, { maxLen, maxBytes, step, pauseMs }) {
  const client = await queue.client;
  const key = queue.keys.events;
  // Clean first: each clean call itself appends a `cleaned` event to the stream.
  const completed = await cleanInSteps(queue, KEEP_COMPLETED.age * 1000, 'completed', {
    step,
    pauseMs,
  });
  const failed = await cleanInSteps(queue, KEEP_FAILED.age * 1000, 'failed', { step, pauseMs });

  const before = Number(await client.xlen(key));
  const bytes = Number(await client.call('MEMORY', 'USAGE', key)) || 0;
  const target = bytes > maxBytes ? 0 : maxLen;

  // Exact MAXLEN, not `~`: an approximate trim only drops whole radix nodes,
  // and an oversized entry is a node of its own, so `~` can leave the very
  // entries this exists to remove.
  let len = before;
  while (len > target) {
    await client.xtrim(key, 'MAXLEN', Math.max(target, len - step));
    len = Number(await client.xlen(key));
    if (len > target) await sleep(pauseMs);
  }

  return {
    name: queue.name,
    events: { before, after: len, removed: before - len, bytes },
    completed,
    failed,
  };
}

async function cleanInSteps(queue, graceMs, type, { step, pauseMs }) {
  // Ask first: a clean call appends a `cleaned` event even when it removes
  // nothing, so calling it unconditionally would grow the stream on every boot.
  // Finished sets are scored by finishedOn, the same clock clean() goes by.
  const client = await queue.client;
  const due = Number(await client.zcount(queue.keys[type], '-inf', Date.now() - graceMs));
  if (!due) return 0;
  let total = 0;
  for (;;) {
    const ids = await queue.clean(graceMs, step, type);
    total += ids.length;
    if (ids.length < step) return total;
    await sleep(pauseMs);
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
