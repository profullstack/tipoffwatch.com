/**
 * Sign-ins that are waiting for their code.
 *
 * Stage one of the SiriusXM login leaves a cookie jar and an identity id that
 * stage two needs, and neither belongs in a form field or a browser: the jar is
 * half a session. So it waits here, keyed by the reader, for as long as SXM's
 * own code is good for.
 *
 * In memory, which is correct for this deployment: one container runs the web
 * role, so the request that sent the code and the request that brings it back
 * land in the same process. A second web replica would need this in Redis.
 */

const TTL_MS = 10 * 60 * 1000;
const store = new Map();

function purge() {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
}

export function putPending(userId, state) {
  purge();
  store.set(userId, { ...state, expiresAt: Date.now() + TTL_MS });
}

/** Look without consuming, for the settings page to know which step to draw. */
export function peekPending(userId) {
  purge();
  const entry = store.get(userId);
  return entry ? { email: entry.email, expiresAt: entry.expiresAt } : null;
}

/** Take it, once. A code that fails is a fresh start, never a second try on a used jar. */
export function takePending(userId) {
  purge();
  const entry = store.get(userId) ?? null;
  store.delete(userId);
  return entry;
}

export function dropPending(userId) {
  store.delete(userId);
}

export function _resetPending() {
  store.clear();
}
