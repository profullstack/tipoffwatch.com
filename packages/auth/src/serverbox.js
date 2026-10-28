import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * The server-held box, kept ONLY for customer webhook signing secrets.
 *
 * Those are secrets this site generates to sign its own deliveries, and it has
 * to sign while nobody is present, so they cannot sit behind a reader's vault.
 * Readers' provider logins no longer use this (see secretbox.js / vault.js).
 * Same format as before (v1), keyed by PLAYLIST_SECRET only: the old fallback
 * to DATABASE_URL is gone.
 */
function key() {
  const secret = process.env.PLAYLIST_SECRET;
  if (!secret) throw new Error('no server encryption key (PLAYLIST_SECRET)');
  return createHash('sha256').update(`tipoffwatch/playlist/v1:${secret}`).digest();
}

export function seal(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

export function open(sealed) {
  try {
    const [v, iv, tag, body] = String(sealed).split('.');
    if (v !== 'v1' || !iv || !tag || !body) return null;
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
