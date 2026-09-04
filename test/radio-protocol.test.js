import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';
process.env.PLAYLIST_SECRET ??= 'test-secret-for-sealing-values';
// The device-grant mint launches a real browser at siriusxm.com; never from a test.
process.env.SIRIUSXM_BROWSER_MINT = 'off';

const sxm = await import('../packages/radio/src/siriusxm.js');

/*
 * The protocol layer, with no reader, no database and no SiriusXM.
 *
 * Every pure piece is checked on its own, and the login dance is run end to
 * end against a fake gateway that answers the way the real one was observed
 * to: which cookies it sets, which step wants which bearer, what comes back
 * flat and what comes back nested.
 */

describe('cookie jar', () => {
  test('merges Set-Cookie into one Cookie header, newest winning', () => {
    const jar = sxm.mergeCookies('a=1; b=2', ['b=3; Path=/; HttpOnly', 'c=4']);
    expect(jar).toBe('a=1; b=3; c=4');
  });
  test('starts from nothing', () => {
    expect(sxm.mergeCookies('', ['x=y; Secure'])).toBe('x=y');
    expect(sxm.mergeCookies(undefined, [])).toBe('');
  });
});

describe('jwt expiry', () => {
  const token = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  test('reads exp in seconds and answers in ms', () => {
    expect(sxm.jwtExpiryMs(token(1_700_000_000))).toBe(1_700_000_000_000);
  });
  test('null for anything that is not a JWT', () => {
    expect(sxm.jwtExpiryMs('not-a-jwt')).toBeNull();
    expect(sxm.jwtExpiryMs('a.b')).toBeNull();
    expect(sxm.jwtExpiryMs(`h.${Buffer.from('{}').toString('base64url')}.s`)).toBeNull();
  });
});

describe('station ids', () => {
  test('round-trip', () => {
    const id = sxm.stationId('abc-123', 'channel-xtra');
    expect(id).toBe('sxm:channel-xtra:abc-123');
    expect(sxm.parseStationId(id)).toEqual({ id: 'abc-123', type: 'channel-xtra' });
  });
  test('refuses anything that is not a channel id', () => {
    expect(sxm.parseStationId('sxm:show:abc')).toBeNull();
    expect(sxm.parseStationId('sxm:channel-linear:')).toBeNull();
    expect(sxm.parseStationId('sxm:channel-linear:../x')).toBeNull();
    expect(sxm.parseStationId('sxm:channel-linear:a b')).toBeNull();
    expect(sxm.parseStationId('radio:1')).toBeNull();
    expect(sxm.parseStationId(null)).toBeNull();
  });
});

describe('browse query', () => {
  test('is version 1 plus base64url JSON, sports by default', () => {
    const q = sxm.categoryQuery('sports');
    expect(q.startsWith('1.')).toBe(true);
    const decoded = JSON.parse(Buffer.from(q.slice(2), 'base64url').toString('utf8'));
    const container = Object.values(decoded.containerConfiguration)[0];
    expect(container.filter).toEqual({ one: { filterId: 'sports' } });
    expect(q).not.toContain('=');
  });
  test('news narrows talk to news and politics', () => {
    const decoded = JSON.parse(
      Buffer.from(sxm.categoryQuery('news').slice(2), 'base64url').toString('utf8'),
    );
    const container = Object.values(decoded.containerConfiguration)[0];
    expect(container.filter.and.map((f) => f.filterId)).toEqual([
      'talk',
      'talk--news-and-politics',
    ]);
  });
});

describe('channel art', () => {
  test('wraps a relative key in the CDN envelope, standard base64', () => {
    const url = sxm.imageUrl('/images/ch/espn.png');
    expect(url.startsWith('https://imgsrv-sxm-prod-device.streaming.siriusxm.com/')).toBe(true);
    const payload = JSON.parse(Buffer.from(url.split('.com/')[1], 'base64').toString('utf8'));
    expect(payload.key).toBe('images/ch/espn.png');
    expect(payload.edits[0]).toEqual({ format: { type: 'png' } });
    expect(payload.edits[1]).toEqual({ resize: { width: 300, height: 300 } });
  });
  test('passes absolute urls through and fixes protocol-relative ones', () => {
    expect(sxm.imageUrl('https://x/y.jpg')).toBe('https://x/y.jpg');
    expect(sxm.imageUrl('//x/y.jpg')).toBe('https://x/y.jpg');
    expect(sxm.imageUrl(null)).toBeNull();
  });
});

describe('items to channels', () => {
  const item = (over = {}) => ({
    entity: {
      id: 'e1',
      type: 'channel-linear',
      texts: { title: { default: 'ESPN Radio' }, description: { short: 'Sports talk' } },
      images: { tile: { aspect_1x1: { default: { url: '/a.jpg' } } } },
      ...over,
    },
    decorations: { channelNumberCanonical: 80 },
  });
  test('keeps channels and drops everything else', () => {
    const ch = sxm.itemToChannel(item());
    expect(ch).toMatchObject({
      id: 'e1',
      type: 'channel-linear',
      number: 80,
      title: 'ESPN Radio',
      description: 'Sports talk',
      stationId: 'sxm:channel-linear:e1',
    });
    expect(ch.image).toContain('imgsrv-sxm-prod-device');
    expect(sxm.itemToChannel(item({ type: 'show' }))).toBeNull();
    expect(sxm.itemToChannel({ entity: { id: 'x', texts: {} } })).toBeNull();
    expect(sxm.itemToChannel(null)).toBeNull();
  });
  test('dedupes and orders by number, unnumbered last by name', () => {
    const a = { id: 'a', type: 'channel-linear', number: 82, title: 'B' };
    const b = { id: 'b', type: 'channel-linear', number: null, title: 'Z' };
    const c = { id: 'c', type: 'channel-linear', number: 80, title: 'A' };
    const d = { id: 'd', type: 'channel-xtra', number: null, title: 'M' };
    expect(sxm.dedupeChannels([a, b, c, a, d]).map((x) => x.id)).toEqual(['c', 'a', 'd', 'b']);
  });
});

describe('hls rewriting', () => {
  const proxify = (u) => `/radio/proxy?u=${encodeURIComponent(u)}`;
  test('collapses a master to the variant the reader asked for', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=64000',
      'audio_64k_v3.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=256000',
      'audio_256k_v3.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=128000',
      'audio_128k_v3.m3u8',
      '',
    ].join('\n');
    const out = sxm.rewritePlaylist(
      master,
      'https://cdn.siriusxm.com/ch/master.m3u8',
      '128',
      proxify,
    );
    expect(out).toContain('BANDWIDTH=128000');
    expect(out).not.toContain('256000');
    expect(out).toContain(proxify('https://cdn.siriusxm.com/ch/audio_128k_v3.m3u8'));
  });
  test('proxies every segment and the key, leaves tags alone', () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://api.edge-gateway.siriusxm.com/playback/key/v1/k",IV=0x1',
      '#EXTINF:10,',
      'seg001.aac',
      '#EXTINF:10,',
      '/abs/seg002.aac',
      '',
    ].join('\n');
    const out = sxm.rewritePlaylist(
      media,
      'https://cdn.siriusxm.com/ch/a/media.m3u8',
      '256',
      proxify,
    );
    const lines = out.split('\n');
    expect(lines[1]).toBe('#EXT-X-TARGETDURATION:10');
    expect(lines[2]).toContain(
      `URI="${proxify('https://api.edge-gateway.siriusxm.com/playback/key/v1/k')}"`,
    );
    expect(lines[4]).toBe(proxify('https://cdn.siriusxm.com/ch/a/seg001.aac'));
    expect(lines[6]).toBe(proxify('https://cdn.siriusxm.com/abs/seg002.aac'));
    expect(out).not.toMatch(/^https:\/\/cdn/m);
  });
  test('knows a playlist by url or by type, and a key by path', () => {
    expect(sxm.looksLikePlaylist('https://x/a.m3u8', '')).toBe(true);
    expect(sxm.looksLikePlaylist('https://x/a', 'application/vnd.apple.mpegurl')).toBe(true);
    expect(sxm.looksLikePlaylist('https://x/a.aac', 'audio/aac')).toBe(false);
    expect(sxm.isKeyUrl('https://api.edge-gateway.siriusxm.com/playback/key/v1/abc')).toBe(true);
    expect(sxm.isKeyUrl('https://cdn.siriusxm.com/seg.aac')).toBe(false);
  });
  test('only SiriusXM hosts may be fetched with a bearer', () => {
    expect(sxm.isSiriusXmUrl('https://api.edge-gateway.siriusxm.com/x')).toBe(true);
    expect(sxm.isSiriusXmUrl('https://siriusxm.com/x')).toBe(true);
    expect(sxm.isSiriusXmUrl('https://evilsiriusxm.com/x')).toBe(false);
    expect(sxm.isSiriusXmUrl('https://siriusxm.com.evil.test/x')).toBe(false);
    expect(sxm.isSiriusXmUrl('http://api.edge-gateway.siriusxm.com/x')).toBe(false);
    expect(sxm.isSiriusXmUrl('not a url')).toBe(false);
  });
});

describe('key decoding', () => {
  const bytes = Buffer.from('0123456789abcdef');
  test('base64, base64url, hex and literal', () => {
    expect(sxm.decodeKeyJson({ key: bytes.toString('base64') }).equals(bytes)).toBe(true);
    expect(
      sxm.decodeKeyJson({ result: { value: bytes.toString('base64url') } }).equals(bytes),
    ).toBe(true);
    // A literal that is neither alphabet: taken as the bytes it is.
    expect(sxm.decodeKeyJson({ data: 'raw key sixteen!' }).length).toBe(16);
  });
  test('says so when there is no key', () => {
    expect(() => sxm.decodeKeyJson({ nope: 1 })).toThrow(sxm.SiriusXmError);
  });
});

/*
 * The login dance against a fake gateway.
 *
 * `sxmCall` builds URLs from a constant base, so the fake is reached by
 * pointing `fetch` at it: Bun's fetch is a global and the module reads it at
 * call time. The fake records every request so the test can say which step
 * carried which bearer.
 */
describe('otp login', () => {
  let server;
  let calls;
  const realFetch = globalThis.fetch;
  const session = (token) => ({
    session: {
      accessToken: token,
      accessTokenExpiresAt: '2030-01-01T00:00:00Z',
      refreshTokenExpiresAt: '2031-01-01T00:00:00Z',
    },
  });

  beforeAll(() => {
    calls = [];
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const auth = req.headers.get('authorization');
        calls.push({
          method: req.method,
          path: url.pathname,
          auth,
          cookie: req.headers.get('cookie'),
        });
        const json = (data, status = 200, headers = {}) =>
          new Response(JSON.stringify(data), {
            status,
            headers: { 'content-type': 'application/json', ...headers },
          });
        switch (`${req.method} ${url.pathname}`) {
          case 'GET /identity/v1/identities/status':
            // What a spent residential proxy answers, before SXM sees anything.
            if (url.searchParams.get('handle') === 'capped@example.com') {
              return new Response('Bandwidth limit reached', { status: 402 });
            }
            // Requires a session the first time round, which is what forces the
            // anonymous-session path; the pasted grant makes it possible.
            if (!auth) return json({ error: 'auth' }, 401);
            if (url.searchParams.get('handle') === 'nobody@example.com') return json({});
            return json({ identityId: 'id-1' }, 200, { 'set-cookie': 'sxm=jar1; Path=/' });
          case 'POST /session/v1/sessions/anonymous':
            if (auth !== 'Bearer device-grant') return json({}, 403);
            return json({ accessToken: 'anon-token' }, 200, { 'set-cookie': 'anon=1' });
          case 'POST /otp/v1/otp/initiate':
            return new Response(null, { status: 204 });
          case 'PUT /otp/v1/otp/redeem': {
            const body = await req.json();
            if (body.otp !== '123456') return json({ error: 'bad' }, 400);
            return json({ grant: 'otp-grant' });
          }
          case 'POST /identity/v1/identities/authenticate/otp':
            if (auth !== 'Bearer otp-grant') return json({}, 403);
            return json({ grant: 'identity-grant' });
          case 'POST /identity/v1/identities/authenticate/password': {
            if (!auth) return json({ error: 'auth' }, 401);
            const body = await req.json();
            if (body.handle !== 'me@example.com' || body.password !== 'hunter2') {
              return json({ error: 'bad credentials' }, 401);
            }
            return json({ grant: 'identity-grant' }, 200, { 'set-cookie': 'pw=1' });
          }
          case 'POST /session/v1/sessions/authenticated':
            if (auth !== 'Bearer identity-grant') return json({}, 403);
            return json(session('access-1'), 200, { 'set-cookie': 'refresh=r1; HttpOnly' });
          case 'POST /session/v1/sessions/refresh':
            if (auth) return json({}, 400);
            if (!(req.headers.get('cookie') ?? '').includes('refresh=r1')) return json({}, 401);
            return json(session('access-2'));
          default:
            return json({ error: 'unexpected' }, 500);
        }
      },
    });
    globalThis.fetch = (input, init) => {
      const u = new URL(String(input));
      if (u.hostname === 'api.edge-gateway.siriusxm.com') {
        return realFetch(`http://127.0.0.1:${server.port}${u.pathname}${u.search}`, init);
      }
      return realFetch(input, init);
    };
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    server.stop(true);
  });

  test('walks every step with the right bearer and carries the jar', async () => {
    calls.length = 0;
    const state = await sxm.startOtpLogin('me@example.com', {
      deviceGrant: JSON.stringify({ grant: 'device-grant', refreshGrant: 'x' }),
    });
    expect(state.identityId).toBe('id-1');
    expect(state.anonAccessToken).toBe('anon-token');
    expect(state.cookies).toContain('sxm=jar1');
    expect(state.cookies).toContain('anon=1');

    const result = await sxm.completeOtpLogin(state, '123456');
    expect(result.accessToken).toBe('access-1');
    expect(result.cookies).toContain('refresh=r1');
    expect(result.accessTokenExpiresAt).toBe('2030-01-01T00:00:00Z');

    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toEqual([
      'GET /identity/v1/identities/status',
      'POST /session/v1/sessions/anonymous',
      'GET /identity/v1/identities/status',
      'POST /otp/v1/otp/initiate',
      'PUT /otp/v1/otp/redeem',
      'POST /identity/v1/identities/authenticate/otp',
      'POST /session/v1/sessions/authenticated',
    ]);
    expect(calls[4].auth).toBe('Bearer anon-token');
    expect(calls[4].cookie).toContain('sxm=jar1');
  });

  test("an unknown email is the reader's problem, not ours", async () => {
    await expect(
      sxm.startOtpLogin('nobody@example.com', {
        deviceGrant: JSON.stringify({ grant: 'device-grant' }),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('a wrong code is a 400 with words a reader can act on', async () => {
    const state = await sxm.startOtpLogin('me@example.com', {
      deviceGrant: JSON.stringify({ grant: 'device-grant' }),
    });
    await expect(sxm.completeOtpLogin(state, '000000')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('not accepted'),
    });
  });

  test('the password door: anonymous session, then the grant, then the session', async () => {
    calls.length = 0;
    const result = await sxm.passwordLogin('me@example.com', 'hunter2', {
      deviceGrant: JSON.stringify({ grant: 'device-grant' }),
    });
    expect(result.accessToken).toBe('access-1');
    expect(result.cookies).toContain('refresh=r1');
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toEqual([
      'POST /identity/v1/identities/authenticate/password',
      'POST /session/v1/sessions/anonymous',
      'POST /identity/v1/identities/authenticate/password',
      'POST /session/v1/sessions/authenticated',
    ]);
    expect(calls[2].auth).toBe('Bearer anon-token');
    expect(calls[3].auth).toBe('Bearer identity-grant');
    // The jar from the anonymous session rides along to the password call.
    expect(calls[2].cookie).toContain('anon=1');
  });

  test('a wrong password is a 400 in words, never a 502', async () => {
    await expect(
      sxm.passwordLogin('me@example.com', 'nope', {
        deviceGrant: JSON.stringify({ grant: 'device-grant' }),
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('email and password'),
    });
  });

  test('a 402 is the proxy out of bandwidth, and is said so', async () => {
    await expect(sxm.startOtpLogin('capped@example.com', {})).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('out of bandwidth'),
    });
  });

  test('refresh replays the jar with no bearer', async () => {
    calls.length = 0;
    const r = await sxm.refreshSession('refresh=r1; other=2');
    expect(r.accessToken).toBe('access-2');
    expect(calls[0].auth).toBeNull();
    expect(calls[0].cookie).toBe('refresh=r1; other=2');
    await expect(sxm.refreshSession('stale=1')).rejects.toMatchObject({ status: 401 });
  });

  test('without a device grant and with SXM insisting on one, the failure says the browser could not mint', async () => {
    await expect(sxm.startOtpLogin('me@example.com', {})).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('headless browser could not mint'),
    });
  });

  test('the browser mint is tried first, and its reason travels with the failure', async () => {
    sxm.resetDeviceGrantCache();
    let err;
    await sxm.startOtpLogin('me@example.com', {}).catch((e) => (err = e));
    expect(err.status).toBe(502);
    expect(err.data.browser).toContain('SIRIUSXM_BROWSER_MINT=off');
    expect(Array.isArray(err.data.fetch)).toBe(true);
    expect(err.data.fetch.length).toBeGreaterThan(0);
  });
});
