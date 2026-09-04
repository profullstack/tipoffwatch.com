/**
 * Whose SiriusXM this is.
 *
 * `siriusxm.js` speaks the protocol and takes a bearer as an argument; this file
 * is where the bearer comes from. It reads the reader's stored session, opens
 * it, refreshes it when the token is about to lapse, and writes the new one back
 * -- so a route only ever asks `channels(userId, 'sports')` and never sees a
 * token.
 *
 * Everything stored is sealed with the same key as a playlist URL, for the same
 * reason: a SiriusXM session IS the subscription. Whoever holds it listens as
 * the owner, from anywhere, until the owner changes their password.
 */

import { open, seal } from '@tipoff/auth';
import { config } from '@tipoff/config';
import * as q from '@tipoff/db/queries';
import {
  browseChannels,
  jwtExpiryMs,
  refreshSession,
  SiriusXmError,
  searchChannels,
  tuneChannel,
} from './siriusxm.js';

/* ----------------------------------------------------------------- proxy -- */

/**
 * The residential exit a reader's calls leave through.
 *
 * SXM pins a session to the IP that authenticated it -- the playback key
 * endpoint in particular answers 403 to a bearer arriving from anywhere else
 * -- and answers a datacenter address with 403 before any of that. So every
 * call for a reader goes through the same residential proxy, chosen by hashing
 * their id over the pool, which is what keeps the IP the same across a login,
 * a refresh and a segment fetch a week later.
 *
 * With a single rotating proxy URL and no pool there is nothing to pin, and
 * the calls still work most of the time; the pool is the lever when they stop.
 */
export function proxyFor(userId) {
  const pool = config.radio.proxyPool;
  if (pool.length > 0 && userId) {
    const digest = new Bun.CryptoHasher('sha256').update(String(userId)).digest();
    return pool[new DataView(digest.buffer).getUint32(0) % pool.length];
  }
  return config.radio.proxyUrl || null;
}

/* ---------------------------------------------------------- stored session -- */

/**
 * The reader's session, opened. Null when there is none, or when the stored
 * one can no longer be decrypted -- the key was rotated -- which is treated as
 * "not connected" rather than as an error, so the settings page offers to
 * connect again instead of failing.
 */
export async function storedSession(userId) {
  const row = await q.getSiriusXm(userId);
  if (!row) return null;
  const accessToken = open(row.access_token);
  const cookies = row.session_cookies ? open(row.session_cookies) : '';
  // Who else may listen through this line. Carried on the session so settings
  // can draw the sharing card from the one row read it already makes.
  const sharing = {
    shared: Boolean(row.shared),
    shareAudience: row.share_audience ?? 'none',
    sharedAt: row.shared_at ?? null,
    sharedLabel: row.shared_label ?? null,
  };
  if (accessToken === null || cookies === null) {
    return { unreadable: true, email: row.email, ...sharing };
  }
  return {
    email: row.email,
    accessToken,
    cookies,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    connectedAt: row.created_at,
    updatedAt: row.updated_at,
    ...sharing,
  };
}

export async function saveSession(
  userId,
  { email, accessToken, cookies, accessTokenExpiresAt, refreshTokenExpiresAt },
) {
  await q.saveSiriusXm({
    userId,
    email: email ?? null,
    accessToken: seal(accessToken),
    sessionCookies: seal(cookies ?? ''),
    accessTokenExpiresAt: accessTokenExpiresAt ?? null,
    refreshTokenExpiresAt: refreshTokenExpiresAt ?? null,
  });
  forget(userId);
}

export async function disconnect(userId) {
  await q.deleteSiriusXm(userId);
  forget(userId);
}

/* ---------------------------------------------------------------- bearer -- */

/** Refresh this long before the token says it expires, so a call in flight does not straddle it. */
const EXPIRY_SAFETY_MS = 30_000;

/** userId -> { accessToken, expMs } */
const bearers = new Map();
/** userId -> Promise<string>, so ten segment fetches at once mint one refresh. */
const inflight = new Map();

export function forget(userId) {
  bearers.delete(userId);
  inflight.delete(userId);
}

const expired = (b) => b.expMs !== null && Date.now() + EXPIRY_SAFETY_MS >= b.expMs;

async function loadBearer(userId) {
  const stored = await storedSession(userId);
  if (!stored || stored.unreadable) {
    throw new SiriusXmError('SiriusXM is not connected. Connect it in settings.', 401);
  }
  const fresh = { accessToken: stored.accessToken, expMs: jwtExpiryMs(stored.accessToken) };
  if (!expired(fresh)) {
    bearers.set(userId, fresh);
    return fresh.accessToken;
  }
  if (!stored.cookies) {
    throw new SiriusXmError(
      'Your SiriusXM session has expired. Connect it again in settings.',
      401,
    );
  }
  const refreshed = await refreshSession(stored.cookies, { proxy: proxyFor(userId) });
  await q.saveSiriusXm({
    userId,
    email: stored.email,
    accessToken: seal(refreshed.accessToken),
    sessionCookies: seal(refreshed.cookies),
    accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
    refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
  });
  const next = { accessToken: refreshed.accessToken, expMs: jwtExpiryMs(refreshed.accessToken) };
  bearers.set(userId, next);
  return next.accessToken;
}

/** A bearer that is good for at least the next thirty seconds. */
export async function bearerFor(userId) {
  const cached = bearers.get(userId);
  if (cached && !expired(cached)) return cached.accessToken;
  const existing = inflight.get(userId);
  if (existing) return existing;
  const p = loadBearer(userId).finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}

/** What every protocol call takes: where the bearer comes from, where to exit, what to do on a 401. */
const ctxFor = (userId) => ({
  bearer: () => bearerFor(userId),
  proxy: proxyFor(userId),
  unauthorized: () => forget(userId),
});

/* -------------------------------------------------------------- channels -- */

/**
 * The lineup is the same for everyone, so it is fetched once and shared.
 *
 * Fifteen minutes: channel numbers and names change at the pace of a press
 * release, and what a reader can actually play is decided at tune time, not
 * here. Keyed by category only -- whichever reader's bearer fetched it, the
 * sports page is the sports page.
 */
const LINEUP_TTL_MS = 15 * 60 * 1000;
const lineups = new Map();

export async function channels(userId, cat) {
  const hit = lineups.get(cat);
  if (hit && hit.expiresAt > Date.now()) return hit.channels;
  if (hit?.pending) return hit.pending;
  const pending = browseChannels(cat, ctxFor(userId))
    .then((list) => {
      lineups.set(cat, { channels: list, expiresAt: Date.now() + LINEUP_TTL_MS });
      return list;
    })
    .catch((err) => {
      lineups.delete(cat);
      throw err;
    });
  lineups.set(cat, { pending, expiresAt: 0 });
  return pending;
}

export function search(userId, query) {
  return searchChannels(query, ctxFor(userId));
}

/** One channel by id, from whichever lineup carries it. Null when neither does. */
export async function channel(userId, stationId) {
  for (const cat of ['sports', 'news']) {
    const found = (await channels(userId, cat)).find((ch) => ch.stationId === stationId);
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ tune -- */

/**
 * Tune URLs are signed and short-lived, and minting one is a request SXM
 * counts. Held per reader and channel until shortly before it lapses, so a
 * manifest refresh every few seconds does not mint one every few seconds.
 */
const TUNE_TTL_MS = 60_000;
const TUNE_MARGIN_MS = 10_000;
const tunes = new Map();

export async function tune(userId, parsed) {
  const key = `${userId}:${parsed.type}:${parsed.id}`;
  const hit = tunes.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.url;
  const { url, validUntil } = await tuneChannel(parsed, ctxFor(userId));
  const until = validUntil ? Date.parse(validUntil) : Number.NaN;
  const expiresAt = Math.min(
    Number.isFinite(until) ? until - TUNE_MARGIN_MS : Number.POSITIVE_INFINITY,
    Date.now() + TUNE_TTL_MS,
  );
  tunes.set(key, { url, expiresAt });
  return url;
}

export function _resetSessionCaches() {
  bearers.clear();
  inflight.clear();
  lineups.clear();
  tunes.clear();
}
