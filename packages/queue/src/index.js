import { config } from '@tipoff/config';
import { sql } from '@tipoff/db';
import * as q from '@tipoff/db/queries';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

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
  await queues.sync.add(
    'sync-catalogue',
    { kind: 'catalogue' },
    { repeat: { every: 24 * 3600_000 } },
  );

  // Two problems solved by the same check.
  //
  // First, a repeatable job runs one interval from NOW, not immediately -- so a
  // fresh database would serve an empty calendar for a full day.
  //
  // Second, and less obvious: clearing and re-adding the repeatables above resets
  // their timers, so on a day of frequent deploys the six-hour sync is pushed six
  // hours into the future every time and never actually fires.
  //
  // So the trigger is data staleness rather than a fresh timer, which is
  // self-correcting in both cases and idles harmlessly when the data is current.
  const [cat] = await sql`
    select count(*)::int as leagues,
           max(created_at) as newest
    from leagues
  `;
  const [ev] = await sql`select max(updated_at) as synced from events`;

  const staleBy = (ts, ms) => !ts || Date.now() - new Date(ts).getTime() > ms;

  if (staleBy(cat.newest, 24 * 3600_000) || cat.leagues === 0) {
    log('[queue] catalogue stale, refreshing now');
    await queues.sync.add(
      'sync-catalogue',
      { kind: 'catalogue' },
      { jobId: `seed-cat:${dayStamp()}` },
    );
  }
  // Display names only arrive with a fixture sweep, so a catalogue that has never
  // been swept shows raw slugs however fresh its fixtures are.
  const unnamed = await q.leaguesMissingRealName();

  if (staleBy(ev.synced, 6 * 3600_000) || unnamed > 0) {
    log(
      `[queue] syncing now (fixtures stale: ${staleBy(ev.synced, 6 * 3600_000)}, unnamed leagues: ${unnamed})`,
    );
    await queues.sync.add(
      'sync-all',
      { kind: 'all' },
      { jobId: `seed-all:${hourStamp()}`, delay: 20_000 },
    );
  }

  log('[queue] schedules installed');
}

/* Job ids are bucketed by time so that several instances booting together -- or one
   instance restarting twice in a minute -- enqueue the same job rather than one each. */
const dayStamp = () => new Date().toISOString().slice(0, 10);
const hourStamp = () => new Date().toISOString().slice(0, 13);

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await connection.quit();
}
