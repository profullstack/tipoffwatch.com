import { config } from '@tipoff/config';
import { close as closeDb, healthcheck } from '@tipoff/db';
import { migrate } from '@tipoff/db/migrate';
import { closeQueues, installSchedules } from '@tipoff/queue';
import { startWorkers } from '@tipoff/queue/workers';
import { assertCoinpayMerchantKey } from '@tipoff/config';
import { app } from './app.js';

/**
 * One process, one container, one Railway service.
 *
 * ROLES decides what this instance actually runs. It defaults to "web,worker" so a
 * single service does everything; splitting the workers onto their own instance
 * later is a variable change rather than a rebuild.
 */

// Fail at boot rather than at checkout if the CoinPay credential is the wrong family.
assertCoinpayMerchantKey();

// Migrations apply themselves. An advisory lock inside makes this safe when the web
// and worker roles boot at the same moment.
await migrate();

if (!(await healthcheck())) throw new Error('database healthcheck failed at boot');

let workers = [];
if (config.roles.includes('worker')) {
  await installSchedules();
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

async function shutdown(signal) {
  console.log(`[main] ${signal}, draining`);
  // Stop taking new work before closing the pool, so an in-flight fan-out finishes
  // its claim rather than half-sending a batch.
  await Promise.allSettled([
    server?.stop(true),
    ...workers.map((w) => w.close()),
  ]);
  await Promise.allSettled([closeQueues(), closeDb()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
