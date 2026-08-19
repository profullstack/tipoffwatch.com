import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '@tipoff/config';
import { sql } from '@tipoff/db';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on, or
 * a blocking read that outlives the retry budget kills the worker. Sharing one
 * connection object across queues keeps the socket count flat as queues are added.
 */
export const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const QUEUES = {
  /** Fixture ingestion from the sports providers. */
  sync: 'sync',
  /** Ticks every 30s and asks "what crosses a reminder threshold right now?" */
  scan: 'reminder-scan',
  /** One job per (event, offset). Pages followers into batch jobs. */
  fanout: 'reminder-fanout',
  /** One job per page of followers. Claims and sends. */
  batch: 'reminder-batch',
};

const defaults = {
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 86400 },
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
};

export const queues = Object.fromEntries(
  Object.entries(QUEUES).map(([k, name]) => [
    k,
    new Queue(name, { connection, defaultJobOptions: defaults }),
  ]),
);

/**
 * Repeatable jobs are declared, not accumulated.
 *
 * BullMQ keys a repeatable by its pattern, so changing an interval leaves the old
 * schedule running forever unless the previous one is removed. Clearing them on
 * every boot makes the code the single source of truth for what is scheduled.
 */
export async function installSchedules({ log = console.log } = {}) {
  for (const q of [queues.scan, queues.sync]) {
    for (const r of await q.getRepeatableJobs()) await q.removeRepeatableByKey(r.key);
  }

  // A 1-minute reminder needs sub-minute resolution to land on time.
  await queues.scan.add('scan', {}, { repeat: { every: 30_000 }, jobId: 'scan' });

  // Fixtures move rarely; the horizon only needs refreshing a few times a day.
  await queues.sync.add('sync-all', { kind: 'all' }, { repeat: { every: 6 * 3600_000 } });
  await queues.sync.add('sync-catalogue', { kind: 'catalogue' }, { repeat: { every: 24 * 3600_000 } });

  // A repeatable job first runs one interval from now, not immediately -- so on a
  // fresh database the catalogue would sit empty for a full day and the site would
  // serve an empty calendar to everyone who arrived first. Seed it once, but only
  // when there is nothing there: firing this on every restart would re-sync 354
  // leagues each time a deploy rolls.
  const [{ count }] = await sql`select count(*)::int as count from leagues`;
  if (count === 0) {
    log('[queue] empty catalogue, seeding now');
    await queues.sync.add('sync-catalogue', { kind: 'catalogue' }, { jobId: 'seed-catalogue' });
    await queues.sync.add('sync-all', { kind: 'all' }, { jobId: 'seed-all', delay: 30_000 });
  }

  log('[queue] schedules installed');
}

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await connection.quit();
}
