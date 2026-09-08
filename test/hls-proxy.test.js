import { describe, expect, test } from 'bun:test';

import { isPlaylist, rewritePlaylist, signUrl, unsignUrl } from '../packages/playlists/src/hls.js';
import { assertPublicUrl, fetchPublic, isPrivateIp } from '../packages/playlists/src/publicurl.js';

const SECRET = 'test-secret-not-a-real-one';

/** A DNS stub, so the refusal branches are testable without a hostile resolver. */
const lookupOf = (map) => async (host) => {
  const hit = map[host];
  if (!hit) throw new Error('ENOTFOUND');
  return hit.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe('what counts as a private address', () => {
  test('the ranges that are not routable on the public internet', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '0.0.0.0',
      '100.64.0.1', // carrier-grade NAT
      '169.254.169.254', // the cloud metadata address
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test('ordinary public addresses are allowed', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  test('IPv6 loopback, unique-local and link-local', () => {
    for (const ip of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test('an IPv4 address wearing an IPv6 hat is still that address', () => {
    // ::ffff:10.0.0.1 reaches 10.0.0.1. Judging the string rather than the
    // address is how a guard gets walked straight through.
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });

  test('anything unparseable is refused rather than assumed public', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(isPrivateIp('999.1.1.1')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  const lookup = lookupOf({
    'cdn.example.com': ['93.184.216.34'],
    'evil.example.com': ['10.0.0.5'],
    'split.example.com': ['93.184.216.34', '127.0.0.1'],
  });

  test('a public host passes', async () => {
    const url = await assertPublicUrl('https://cdn.example.com/live.m3u8', { lookup });
    expect(url.hostname).toBe('cdn.example.com');
  });

  test('a public NAME pointing at a private address is refused', async () => {
    // The whole reason this resolves rather than pattern-matching hostnames.
    await expect(assertPublicUrl('https://evil.example.com/x', { lookup })).rejects.toThrow(
      /private address/,
    );
  });

  test('a host that answers with one public and one private address is refused', async () => {
    // Which address connect(2) picks is not ours to decide, so "one of them is
    // fine" is not a defence.
    await expect(assertPublicUrl('https://split.example.com/x', { lookup })).rejects.toThrow(
      /private address/,
    );
  });

  test('internal-looking names are refused before DNS is even asked', async () => {
    for (const u of [
      'http://postgres.railway.internal:5432/',
      'http://localhost/x',
      'http://redis.local/x',
    ]) {
      await expect(assertPublicUrl(u, { lookup })).rejects.toThrow(/internal|private/);
    }
  });

  test('only http and https', async () => {
    for (const u of ['file:///etc/passwd', 'gopher://x/1', 'ftp://x/y']) {
      await expect(assertPublicUrl(u, { lookup })).rejects.toThrow(/refusing|not a url/);
    }
  });
});

describe('fetchPublic follows redirects itself', () => {
  const lookup = lookupOf({
    'cdn.example.com': ['93.184.216.34'],
    'evil.example.com': ['10.0.0.5'],
  });

  test('a redirect into a private address is refused at the hop', async () => {
    // redirect:'follow' would have made this connection before anything could
    // look at it. That is the entire reason the hops are walked by hand.
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'http://evil.example.com/x' } });
    try {
      await expect(fetchPublic('https://cdn.example.com/live.m3u8', { lookup })).rejects.toThrow(
        /private address/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a channel that never answers is given up on, not waited out', async () => {
    // Measured in production before this existed: a dead channel held the
    // request open for the full 30 seconds the client would wait.
    const original = globalThis.fetch;
    globalThis.fetch = (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    try {
      const started = Date.now();
      await expect(
        fetchPublic('https://cdn.example.com/live.m3u8', { lookup, connectTimeoutMs: 50 }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a redirect chain that never settles is refused', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example.com/again' },
      });
    try {
      await expect(
        fetchPublic('https://cdn.example.com/live.m3u8', { lookup, maxHops: 2 }),
      ).rejects.toThrow(/too many redirects/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('signed segment urls', () => {
  test('a token round-trips', () => {
    const url = 'https://cdn.example.com/seg/00001.ts?token=abc';
    expect(unsignUrl(signUrl(url, SECRET), SECRET)).toBe(url);
  });

  test('a tampered payload is refused', () => {
    // Without this the rewritten url is an open proxy with a front door.
    const token = signUrl('https://cdn.example.com/a.ts', SECRET);
    const [payload, sig] = token.split('.');
    const forged = `${Buffer.from('http://169.254.169.254/latest/meta-data').toString('base64url')}.${sig}`;
    expect(unsignUrl(forged, SECRET)).toBeNull();
    expect(unsignUrl(`${payload}.deadbeef`, SECRET)).toBeNull();
  });

  test('a token signed with another secret is refused', () => {
    expect(unsignUrl(signUrl('https://cdn.example.com/a.ts', 'other'), SECRET)).toBeNull();
  });

  test('rubbish is refused rather than throwing', () => {
    for (const t of ['', 'nodot', '.', undefined, null]) {
      expect(unsignUrl(t, SECRET)).toBeNull();
    }
  });
});

describe('rewriting a playlist', () => {
  const base = 'https://cdn.example.com/live/index.m3u8';
  const proxy = (u) => `/watch/seg/${signUrl(u, SECRET)}`;
  const back = (line) => unsignUrl(line.replace('/watch/seg/', ''), SECRET);

  test('relative and absolute segment urls both come back through us', () => {
    const out = rewritePlaylist(
      ['#EXTM3U', '#EXTINF:6.0,', '0001.ts', '#EXTINF:6.0,', 'https://other.example/0002.ts'].join(
        '\n',
      ),
      base,
      proxy,
    ).split('\n');
    expect(back(out[2])).toBe('https://cdn.example.com/live/0001.ts');
    expect(back(out[4])).toBe('https://other.example/0002.ts');
  });

  test('the decryption key is rewritten too', () => {
    // Missed, an encrypted stream fails looking like a codec bug rather than
    // like a key the browser could not fetch.
    const out = rewritePlaylist('#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1234', base, proxy);
    expect(out).toContain('METHOD=AES-128');
    expect(out).toContain('IV=0x1234');
    expect(back(/URI="([^"]+)"/.exec(out)[1])).toBe('https://cdn.example.com/live/key.bin');
  });

  test('the init segment and alternate audio are rewritten', () => {
    for (const tag of ['#EXT-X-MAP:URI="init.mp4"', '#EXT-X-MEDIA:TYPE=AUDIO,URI="a/audio.m3u8"']) {
      const out = rewritePlaylist(tag, base, proxy);
      expect(out).toContain('/watch/seg/');
    }
  });

  test('comments and directives that carry no url are left exactly alone', () => {
    const src = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', ''].join('\n');
    expect(rewritePlaylist(src, base, proxy)).toBe(src);
  });

  test('a variant playlist is rewritten, so the next level also proxies', () => {
    const out = rewritePlaylist(
      ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000', '720p/index.m3u8'].join('\n'),
      base,
      proxy,
    ).split('\n');
    expect(back(out[2])).toBe('https://cdn.example.com/live/720p/index.m3u8');
  });
});

describe('isPlaylist', () => {
  test('by content type, or by extension when the server does not say', () => {
    expect(isPlaylist('application/vnd.apple.mpegurl', 'https://x/a')).toBe(true);
    expect(isPlaylist('audio/x-mpegurl', 'https://x/a')).toBe(true);
    expect(isPlaylist('application/octet-stream', 'https://x/live.m3u8?t=1')).toBe(true);
    expect(isPlaylist('video/mp2t', 'https://x/0001.ts')).toBe(false);
  });
});
