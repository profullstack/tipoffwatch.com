import { assertCoinpayMerchantKey, config } from '@tipoff/config';
import { close as closeDb, healthcheck, sql } from '@tipoff/db';
import { migrate } from '@tipoff/db/migrate';
import { configurePayments } from '@tipoff/payments';
import { closeQueues, connection, installSchedules } from '@tipoff/queue';
import { startWorkers } from '@tipoff/queue/workers';
import { app } from './app.js';
import { startDbWatchdog } from './lib/db-watchdog.js';

/*
 * Hand the payments package its database handle and settings.
 *
 * It imports nothing from this brand -- that is what lets the same file live in
 * both siblings unchanged -- so it has to be given `sql` and the CoinPay block
 * once, here, before anything can take money. The coinpay object is passed whole
 * rather than unpacked: its keys are getters that read the environment on every
 * access, and snapshotting them is the bug their comment in config warns about.
 */
configurePayments({ sql, coinpay: config.coinpay, siteUrl: config.siteUrl });

/**
 * One process, one container, one Railway service.
 *
 * ROLES decides what this instance actually runs. It defaults to "web,worker" so a
 * single service does everything; splitting the workers onto their own instance
 * later is a variable change rather than a rebuild.
 */

// Fail at boot rather than at checkout if the CoinPay credential is the wrong family.
assertCoinpayMerchantKey();

/**
 * Turn an infrastructure failure into a sentence someone can act on.
 *
 * A container that cannot reach Postgres dies with `ERR_POSTGRES_CONNECTION_CLOSED`
 * and a stack trace inside Bun's driver. That is indistinguishable from a bug in
 * this app, and the actual cause is nearly always a variable that was never set on
 * the service — which the deploy log should say outright rather than making someone
 * infer it from a driver internal.
 */
async function preflight(what, fn) {
  try {
    return await fn();
  } catch (err) {
    const target = what === 'postgres' ? config.databaseUrl : config.redisUrl;
    // Host only — a connection string carries the password.
    let host = 'unparseable';
    try {
      host = new URL(target).host;
    } catch {}
    console.error(
      `[boot] cannot reach ${what} at ${host}: ${err?.message ?? err}\n` +
        `[boot] check the ${what === 'postgres' ? 'DATABASE_URL' : 'REDIS_URL'} variable on this service ` +
        `(Railway does not share variables between services — a datastore in another project is not reachable).`,
    );
    throw err;
  }
}

// Migrations apply themselves. An advisory lock inside makes this safe when the web
// and worker roles boot at the same moment.
await preflight('postgres', () => migrate());

if (!(await healthcheck())) throw new Error('database healthcheck failed at boot');

let workers = [];
if (config.roles.includes('worker')) {
  await preflight('redis', () => installSchedules());
  workers = startWorkers();
}

let server;
if (config.roles.includes('web')) {
  // Railway injects PORT. Never hardcode it: a fixed port leaves the edge proxy
  // forwarding to a closed socket and every request 404s while the container
  // still reports healthy.
  server = Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 30 });
  console.log(`[web] listening on :${server.port} as ${config.roles.join('+')}`);
}

/*
 * Watch the two clients the requests actually use.
 *
 * Both are started for either role, because both roles depend on both: the web
 * side reads the page cache and writes passkey challenges through the same Redis
 * client the workers queue on, and a wedged worker stops every score updating
 * without anything going red.
 *
 * The probes deliberately go through the shared `sql` handle and the shared
 * `connection`, not a fresh one -- see db-watchdog.js for why a second connection
 * is the one thing guaranteed to look healthy during this failure. `healthcheck()`
 * runs `select 1`; `connection.ping()` is the Redis equivalent and is what hung on
 * 2026-09-13 and 2026-09-22 while `/healthz` went on answering 200.
 *
 * Read from the environment directly, the way DB_POOL_MAX already is, and every
 * knob has a working default so a service needs no new variables.
 */
const watchdogs = [
  startDbWatchdog({
    subject: 'the database pool',
    probe: async () => {
      if (!(await healthcheck())) throw new Error('select 1 did not come back');
    },
    intervalMs: Number(process.env.DB_WATCHDOG_INTERVAL_MS ?? 30_000),
    timeoutMs: Number(process.env.DB_WATCHDOG_TIMEOUT_MS ?? 10_000),
    failures: Number(process.env.DB_WATCHDOG_FAILURES ?? 3),
  }),
  startDbWatchdog({
    subject: 'redis',
    probe: async () => {
      if ((await connection.ping()) !== 'PONG') throw new Error('PING did not come back');
    },
    /*
     * One more failure than the pool gets, because a healthy Redis here is
     * routinely unreachable for a while: it restarts by reading an RDB off the
     * volume before it accepts anything, 26 seconds at the last measurement and
     * 124 before the event streams were trimmed. Four 30-second probes puts the
     * floor around two minutes, which a normal restart stays well under. Tripping
     * early would be worse than useless -- boot does `preflight('redis')` and
     * throws if Redis is absent, so an impatient watchdog turns one Redis deploy
     * into a deploy loop on this service.
     */
    intervalMs: Number(process.env.REDIS_WATCHDOG_INTERVAL_MS ?? 30_000),
    timeoutMs: Number(process.env.REDIS_WATCHDOG_TIMEOUT_MS ?? 10_000),
    failures: Number(process.env.REDIS_WATCHDOG_FAILURES ?? 4),
  }),
];

async function shutdown(signal) {
  console.log(`[main] ${signal}, draining`);
  // Before anything else: a shutdown closes these clients, and a watchdog probing
  // a closing pool would call a clean drain a wedge and exit(1) over the top of it.
  for (const w of watchdogs) w.stop();
  // Stop taking new work before closing the pool, so an in-flight fan-out finishes
  // its claim rather than half-sending a batch.
  await Promise.allSettled([server?.stop(true), ...workers.map((w) => w.close())]);
  await Promise.allSettled([closeQueues(), closeDb()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
