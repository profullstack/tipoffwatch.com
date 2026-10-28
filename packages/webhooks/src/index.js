import { postgresStore, WebhookError, Webhooks, webhooksApi } from '@profullstack/webhooks';
import { open, seal } from '@tipoff/auth/secretbox';
import { config } from '@tipoff/config';
import { sql } from '@tipoff/db';
import { userIdForApiKey } from './apikeys.js';
import { EVENT_TYPES, pruneMarks, scanOnce } from './scan.js';

/**
 * Customer webhooks: a signed CloudEvent to a reader's own URL when a game they
 * follow is about to start, starts, finishes, or its line moves.
 *
 * @profullstack/webhooks does the rest -- endpoints, whsec_ signing keys, event
 * filters, the durable outbox with backoff, the delivery log, SSRF-safe URLs and
 * the /api/v1/webhooks routes. What lives here is tipoffwatch's half: the store
 * on Bun.SQL, who the caller is, and the scan that finds the events (scan.js).
 *
 * The owner of every endpoint and event is the account, users.id as text.
 */

// For tests and receivers in this repo, which resolve packages from the root.
export { postgresStore, schemaSql, verifyAndParse, Webhooks } from '@profullstack/webhooks';
export { apiKeyInfo, createApiKey, KEY_PREFIX, revokeApiKey } from './apikeys.js';
export { EVENT_DESCRIPTIONS, EVENT_TYPES, HOURLY_CAP } from './scan.js';
export { WebhookError };

/**
 * Bun.SQL as the pg-style pool the store and the scan want:
 * `query(text, params) -> { rows }`. Bun.SQL is not a pg pool; `unsafe` is its
 * parameterised raw query, and it takes `$1, $2...`, which is what the store
 * already writes. The spread turns Bun's result (an array with extra fields)
 * into a plain array.
 */
export function pgPool(db) {
  return {
    async query(text, params = []) {
      const rows = await db.unsafe(text, params);
      return { rows: [...rows] };
    },
  };
}

/** The pool every query here goes through. */
export const pool = pgPool(sql);

/**
 * Make a hub. The app uses `hooks()`; tests make their own with a memory store.
 *
 * Signing secrets are sealed at rest with the same AES-GCM box as a reader's
 * playlist address (@tipoff/auth/secretbox), so a database dump holds no key
 * that can forge a delivery.
 */
export function createHub({ store, secretBox, fetchImpl, guard, backoffMs, now } = {}) {
  return new Webhooks({
    store: store ?? postgresStore(pool),
    source: config.siteUrl,
    eventTypes: EVENT_TYPES,
    ...(store ? (secretBox ? { secretBox } : {}) : { secretBox: secretBox ?? { seal, open } }),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(guard ? { guard } : {}),
    ...(backoffMs ? { backoffMs } : {}),
    ...(now ? { now } : {}),
    log: (message) => console.log(`[webhooks] ${message}`),
  });
}

let hub = null;

/** The app's hub. WEBHOOKS_ALLOW_PRIVATE=1 lets an endpoint be http:// or local (development only). */
export function hooks() {
  hub ??= createHub(
    process.env.WEBHOOKS_ALLOW_PRIVATE === '1' && !config.isProd
      ? { guard: { allowHttp: true, allowPrivate: true } }
      : {},
  );
  return hub;
}

/** For tests: use this hub instead. */
export function useHub(next) {
  hub = next;
}

const READS = new Set(['GET', 'HEAD']);

/**
 * Who is asking.
 *
 * `Authorization: Bearer tok_...` (the personal key from /settings/webhooks)
 * always works. A signed-in browser works too: on reads always, on writes only
 * when the request's Origin is this site. The session cookie is SameSite=Lax,
 * which still lets another site's top-level form POST carry it; the Origin check
 * is what stops that being a way to plant an endpoint on someone's account.
 *
 * `sessionUser` is the user the app's middleware already resolved from the
 * cookie (null when signed out).
 */
export async function webhookOwner(
  request,
  sessionUser,
  { site = config.siteUrl, lookup = (k) => userIdForApiKey(pool, k) } = {},
) {
  const header = request.headers.get('authorization') ?? '';
  if (/^bearer\s+/i.test(header))
    return (await lookup(header.replace(/^bearer\s+/i, '').trim())) ?? null;
  if (!sessionUser?.id) return null;
  if (READS.has(request.method.toUpperCase())) return String(sessionUser.id);
  const origin = request.headers.get('origin');
  return origin && origin === new URL(site).origin ? String(sessionUser.id) : null;
}

export const BASE_PATH = '/api/v1/webhooks';

/** The /api/v1/webhooks API for one request whose owner is already known. */
export function webhooksHandler(owner, current = hooks()) {
  return webhooksApi(current, { basePath: BASE_PATH, owner: () => owner });
}

/**
 * Queue an event for one account. Never throws: a webhook that cannot be queued
 * must not fail whatever caused it.
 */
export async function emit(owner, type, data, options) {
  if (!owner) return;
  try {
    await hooks().emit(String(owner), type, data, options);
  } catch (err) {
    console.error(`[webhooks] could not queue ${type}: ${err?.message ?? err}`);
  }
}

/**
 * The worker role's half: deliver what is due (every 5 s, with the package's
 * backoff) and scan for new events every `scanMs`. Once per process, at boot;
 * several processes are safe (deliveries are claimed with SKIP LOCKED, events
 * with webhook_marks). Returns a stop function for shutdown.
 */
export function startWebhooks({ scanMs = 30_000 } = {}) {
  const current = hooks().start();
  let running = false;
  let passes = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const queued = await scanOnce({
        db: pool,
        emit: (owner, type, data, options) => current.emit(owner, type, data, options),
        siteUrl: config.siteUrl,
        log: (m) => console.log(`[webhooks] ${m}`),
      });
      const total = Object.values(queued).reduce((a, b) => a + b, 0);
      if (total > 0) console.log(`[webhooks] queued ${JSON.stringify(queued)}`);
      // Hourly-ish housekeeping at the default interval.
      if (++passes % 120 === 1) await pruneMarks(pool);
    } catch (err) {
      console.error('[webhooks] scan failed', err?.message ?? err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, scanMs);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return () => {
    clearInterval(timer);
    current.stop();
  };
}
