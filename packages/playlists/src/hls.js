import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proxying an HLS stream, for channels nobody signed up for.
 *
 * The existing player reads MPEG-TS and refuses a playlist outright ("that
 * channel is an HLS playlist"), which was the right answer while every channel
 * came from a provider line that served transport stream. Public news channels
 * are the opposite: measured against the iptv-org directory, effectively all of
 * them are `.m3u8`. So they need the other kind of proxy.
 *
 * An HLS proxy is two jobs, not one. Fetching the playlist is the easy half; the
 * half that matters is that a playlist is a list of FURTHER urls, and a browser
 * will fetch those itself. Handing back the upstream's own segment urls would
 * defeat the point -- the reader's browser would talk to the provider directly,
 * leaking their address and failing on CORS besides -- so every url inside the
 * playlist is rewritten to come back through here.
 *
 * Which raises the question this file exists to answer: the rewritten url has to
 * carry the upstream address, and anything a client can carry, a client can
 * change. An unsigned `?u=` parameter is an open proxy, and an open proxy on a
 * host inside a private network is a server-side request forgery hole with a
 * front door. So each url is signed, and the segment route refuses anything
 * whose signature it did not write.
 */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const mac = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url');

/** A url the segment route will accept back, and nothing else will. */
export function signUrl(url, secret) {
  const payload = b64url(String(url));
  return `${payload}.${mac(payload, secret)}`;
}

/**
 * The url a token stands for, or null.
 *
 * Compared with `timingSafeEqual`, because a byte-at-a-time comparison of a MAC
 * leaks the MAC, and the thing it is protecting is "which addresses will this
 * server fetch for you".
 */
export function unsignUrl(token, secret) {
  const dot = String(token ?? '').lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const want = mac(payload, secret);
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Attributes whose value is a url rather than a number or a name. */
const URI_ATTR = /URI="([^"]*)"/i;

/**
 * Rewrite every url in a playlist so the browser comes back to us for it.
 *
 * Three kinds of line carry one, and missing any of them breaks a real stream:
 *
 * - a bare line, which is a segment or a variant playlist
 * - `URI="…"` on EXT-X-KEY, which is the DECRYPTION KEY. Miss this and an
 *   encrypted stream fails in a way that looks like a codec bug.
 * - `URI="…"` on EXT-X-MAP (the init segment), EXT-X-MEDIA (alternate audio)
 *   and EXT-X-I-FRAME-STREAM-INF
 *
 * Relative urls are resolved against the playlist's own address first, because
 * that is what the browser would have done and our proxy is not at that address.
 */
export function rewritePlaylist(text, baseUrl, toProxy) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('#')) {
      const m = URI_ATTR.exec(trimmed);
      if (
        m &&
        /^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT)/i.test(
          trimmed,
        )
      ) {
        let abs;
        try {
          abs = new URL(m[1], baseUrl).toString();
        } catch {
          out.push(line);
          continue;
        }
        out.push(trimmed.replace(URI_ATTR, `URI="${toProxy(abs)}"`));
        continue;
      }
      out.push(line);
      continue;
    }
    let abs;
    try {
      abs = new URL(trimmed, baseUrl).toString();
    } catch {
      out.push(line);
      continue;
    }
    out.push(toProxy(abs));
  }
  return out.join('\n');
}

/** Whether a response body should be treated as a playlist to rewrite. */
export function isPlaylist(contentType, url) {
  if (/mpegurl/i.test(contentType ?? '')) return true;
  return /\.m3u8(\?|$)/i.test(String(url ?? ''));
}
