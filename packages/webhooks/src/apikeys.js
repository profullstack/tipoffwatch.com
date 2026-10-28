import { createHash, randomBytes } from 'node:crypto';

/**
 * A personal API key: what /api/v1/webhooks takes from a script, the CLI of
 * someone else's making, or an agent. One per account. Only a SHA-256 of it is
 * stored, so it is shown once, when it is made, and a lost key is replaced
 * rather than recovered.
 *
 * Takes a pg-style `db` (`query(text, params) -> { rows }`) like scan.js. The
 * hash travels as hex and is decoded in SQL, so no driver has to bind a Buffer.
 */

export const KEY_PREFIX = 'tok_';

const hashHex = (key) => createHash('sha256').update(String(key)).digest('hex');

/** Make (or replace) the account's key. Returns the key; nothing else ever will. */
export async function createApiKey(db, userId) {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  await db.query(
    `insert into api_keys (user_id, key_hash, hint) values ($1::uuid, decode($2, 'hex'), $3)
     on conflict (user_id) do update
       set key_hash = excluded.key_hash, hint = excluded.hint, created_at = now(), last_used_at = null`,
    [userId, hashHex(key), key.slice(-4)],
  );
  return key;
}

export async function revokeApiKey(db, userId) {
  await db.query('delete from api_keys where user_id = $1::uuid', [userId]);
}

/** What the settings page may show: the last four characters and the dates. */
export async function apiKeyInfo(db, userId) {
  const { rows } = await db.query(
    'select hint, created_at, last_used_at from api_keys where user_id = $1::uuid',
    [userId],
  );
  return rows[0] ?? null;
}

/** The account a key belongs to, or null. Notes when it was last used. */
export async function userIdForApiKey(db, key) {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX) || key.length > 200) return null;
  const { rows } = await db.query(
    `update api_keys set last_used_at = now() where key_hash = decode($1, 'hex')
     returning user_id::text as user_id`,
    [hashHex(key)],
  );
  return rows[0]?.user_id ?? null;
}
