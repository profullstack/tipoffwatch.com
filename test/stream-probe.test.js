import { describe, expect, test } from 'bun:test';
import {
  firstLiveChannel,
  probeStream,
  sniffBytes,
  verdictToStore,
} from '../packages/playlists/src/probe.js';

/**
 * Checking a channel actually plays before anyone is handed it.
 *
 * A provider list is mostly aspirational: the slot exists, the title is right,
 * and a large share answer with an HTML error page instead of video. Measured
 * against a real line, several advertised endpoints returned
 * `text/html; charset=UTF-8` with zero bytes. Offering one of those is worse than
 * offering nothing, because the reader finds out by tapping it mid-match.
 *
 * A local server stands in for the provider, so these run without touching
 * anybody's subscription.
 */

/** Spin up a server that answers each path with a fixed shape. */
function serve(routes) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const r = routes[pathname];
      if (!r) return new Response('nope', { status: 404 });
      if (r.hang) return new Promise(() => {}); // never resolves
      return new Response(r.body ?? 'x', {
        status: r.status ?? 200,
        headers: r.type ? { 'content-type': r.type } : {},
      });
    },
  });
}

describe('what counts as a live stream', () => {
  test('video/mp2t is live, which is what these providers actually serve', async () => {
    const s = serve({ '/ts': { type: 'video/mp2t' } });
    const got = await probeStream(`http://localhost:${s.port}/ts`);
    s.stop(true);
    expect(got.live).toBe(true);
  });

  test('an HLS manifest is live', async () => {
    const s = serve({ '/hls': { type: 'application/vnd.apple.mpegurl' } });
    const got = await probeStream(`http://localhost:${s.port}/hls`);
    s.stop(true);
    expect(got.live).toBe(true);
  });

  test('a 200 that returns HTML is dead, and says so', async () => {
    // The exact failure this exists for: the slot answers 200 with a web page.
    // A status check alone would call this healthy.
    const s = serve({ '/dead': { type: 'text/html; charset=UTF-8', body: '<html>gone' } });
    const got = await probeStream(`http://localhost:${s.port}/dead`);
    s.stop(true);
    expect(got.live).toBe(false);
    expect(got.note).toContain('web page');
  });

  test('an error status is dead, and names the status', async () => {
    const s = serve({ '/err': { status: 503, type: 'video/mp2t' } });
    const got = await probeStream(`http://localhost:${s.port}/err`);
    s.stop(true);
    expect(got.live).toBe(false);
    expect(got.note).toContain('503');
  });

  test('a hanging endpoint times out rather than blocking forever', async () => {
    const s = serve({ '/hang': { hang: true } });
    const started = Date.now();
    const got = await probeStream(`http://localhost:${s.port}/hang`);
    const took = Date.now() - started;
    s.stop(true);
    expect(got.live).toBe(false);
    expect(got.note).toBe('timed out');
    // The point of the bound: a probe must not hold a connection slot that the
    // reader's own playback needs.
    expect(took).toBeLessThan(9000);
  }, 15_000);

  test('an unreachable host is dead, not an exception', async () => {
    const got = await probeStream('http://127.0.0.1:1/nothing');
    expect(got.live).toBe(false);
  });

  test('junk in is dead, not a crash', async () => {
    for (const bad of ['', null, 'not a url', 'vlc://x']) {
      expect((await probeStream(bad)).live).toBe(false);
    }
  });
});

/*
 * What a NO is worth remembering.
 *
 * Reported from /events/266: the right game matched on title and then "failed the
 * check", and sometimes stopped matching at all. Both are the same mechanism. A
 * verdict is written to the row, and the candidate query drops a row marked dead
 * for thirty minutes -- so a single timeout on the correct channel took it off
 * the page and left the next-best thing, of a different sport, in its place.
 *
 * A timeout is a fact about the last six seconds. Only a fact about the SLOT is
 * worth storing.
 */
describe('a no that is worth remembering, and a no that is not', () => {
  test('an HTML apology is definite: that slot really is empty', async () => {
    const s = serve({ '/dead': { type: 'text/html', body: '<html>no such stream</html>' } });
    const got = await probeStream(`http://localhost:${s.port}/dead`);
    s.stop(true);
    expect(got.live).toBe(false);
    expect(got.definitive).toBe(true);
    expect(verdictToStore(got)).toBe(false);
  });

  test('a timeout is not, and must not be written down as one', async () => {
    const s = serve({ '/hang': { hang: true } });
    const got = await probeStream(`http://localhost:${s.port}/hang`);
    s.stop(true);
    expect(got.live).toBe(false);
    expect(got.definitive).toBe(false);
    // NULL, not false. The candidate query treats NULL as offerable, which is
    // the whole point: one slow answer must not hide a working channel.
    expect(verdictToStore(got)).toBe(null);
  }, 15_000);

  test('a reader closing the tab is not a verdict on the channel', async () => {
    const s = serve({ '/hang': { hang: true } });
    const ac = new AbortController();
    const p = probeStream(`http://localhost:${s.port}/hang`, { signal: ac.signal });
    ac.abort();
    const got = await p;
    s.stop(true);
    expect(got.definitive).toBe(false);
    expect(verdictToStore(got)).toBe(null);
  });

  test('a busy line answers 403, and that is not the channel being dead', async () => {
    // An Xtream panel refuses the second connection. It therefore refuses exactly
    // when the reader is already watching the channel it is refusing.
    const s = serve({ '/busy': { status: 403, body: 'too many connections' } });
    const got = await probeStream(`http://localhost:${s.port}/busy`);
    s.stop(true);
    expect(got.live).toBe(false);
    expect(verdictToStore(got)).toBe(null);
  });

  test('a 404 is definite', async () => {
    const s = serve({});
    const got = await probeStream(`http://localhost:${s.port}/gone`);
    s.stop(true);
    expect(verdictToStore(got)).toBe(false);
  });

  test('a yes is always worth keeping', async () => {
    const s = serve({ '/ts': { type: 'video/mp2t' } });
    const got = await probeStream(`http://localhost:${s.port}/ts`);
    s.stop(true);
    expect(verdictToStore(got)).toBe(true);
  });
});

/*
 * The bytes outrank the header.
 *
 * These panels serve transport streams as text/plain, as application/dash+xml and
 * with no content-type at all. Judging on the header alone called those dead --
 * a working channel refused because its server was careless about a string.
 */
describe('judging a stream by what it sends', () => {
  const TS = () => {
    // Two transport-stream packets: sync byte, then 187 bytes of payload.
    const b = new Uint8Array(376);
    b[0] = 0x47;
    b[188] = 0x47;
    return b;
  };

  test('mpeg-ts served as text/plain is live', async () => {
    const s = serve({ '/ts': { type: 'text/plain', body: TS() } });
    const got = await probeStream(`http://localhost:${s.port}/ts`);
    s.stop(true);
    expect(got.live).toBe(true);
  });

  test('mpeg-ts served with no content-type at all is live', async () => {
    const s = serve({ '/ts': { body: TS() } });
    const got = await probeStream(`http://localhost:${s.port}/ts`);
    s.stop(true);
    expect(got.live).toBe(true);
  });

  test('an HTML page dressed as video is still a page', async () => {
    const s = serve({ '/liar': { type: 'video/mp2t', body: '<html>offline</html>' } });
    const got = await probeStream(`http://localhost:${s.port}/liar`);
    s.stop(true);
    expect(got.live).toBe(false);
    expect(got.definitive).toBe(true);
  });

  test('a range the server refuses is retried whole, not called dead', async () => {
    let asked = 0;
    const s = Bun.serve({
      port: 0,
      fetch(req) {
        asked++;
        // A live stream is not a seekable resource, and some panels say so.
        if (req.headers.get('range')) return new Response('', { status: 416 });
        return new Response(TS(), { headers: { 'content-type': 'application/octet-stream' } });
      },
    });
    const got = await probeStream(`http://localhost:${s.port}/ts`);
    s.stop(true);
    expect(asked).toBe(2);
    expect(got.live).toBe(true);
  });

  test('an empty answer proves nothing either way', () => {
    expect(sniffBytes(new Uint8Array(0))).toBe(null);
  });

  test('the sync byte is recognised, and a web page is not', () => {
    expect(sniffBytes(TS())).toBe('stream');
    expect(sniffBytes(new TextEncoder().encode('<!doctype html>'))).toBe('page');
    expect(sniffBytes(new TextEncoder().encode('#EXTM3U\n'))).toBe('stream');
  });
});

describe('falling through to one that works', () => {
  test('the asked-for channel is tried first', async () => {
    const s = serve({ '/a': { type: 'video/mp2t' }, '/b': { type: 'video/mp2t' } });
    const { pick } = await firstLiveChannel([
      { title: 'A', url: `http://localhost:${s.port}/a` },
      { title: 'B', url: `http://localhost:${s.port}/b` },
    ]);
    s.stop(true);
    expect(pick.title).toBe('A');
  });

  test('a dead first choice falls through to a live one', async () => {
    // This is the whole feature: the reader gets a working channel instead of a
    // file that opens to nothing.
    const s = serve({
      '/dead': { type: 'text/html' },
      '/live': { type: 'video/mp2t' },
    });
    const { pick, tried } = await firstLiveChannel([
      { title: 'Dead', url: `http://localhost:${s.port}/dead` },
      { title: 'Live', url: `http://localhost:${s.port}/live` },
    ]);
    s.stop(true);
    expect(pick.title).toBe('Live');
    expect(tried).toHaveLength(2);
  });

  test('all dead returns nothing rather than the first one anyway', async () => {
    const s = serve({ '/d1': { type: 'text/html' }, '/d2': { type: 'text/html' } });
    const { pick, tried } = await firstLiveChannel([
      { title: 'D1', url: `http://localhost:${s.port}/d1` },
      { title: 'D2', url: `http://localhost:${s.port}/d2` },
    ]);
    s.stop(true);
    expect(pick).toBeNull();
    expect(tried.every((t) => !t.live)).toBe(true);
  });

  test('it stops after a bounded number of attempts', async () => {
    // These are one subscriber's own connections and the line caps how many can
    // be open; walking a whole playlist looking for a live one is not polite.
    const s = serve({ '/d': { type: 'text/html' } });
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `C${i}`,
      url: `http://localhost:${s.port}/d`,
    }));
    const { tried } = await firstLiveChannel(many, { max: 4 });
    s.stop(true);
    expect(tried).toHaveLength(4);
  });

  test('each verdict is reported so it can be remembered', async () => {
    const s = serve({ '/d': { type: 'text/html' }, '/l': { type: 'video/mp2t' } });
    const seen = [];
    await firstLiveChannel(
      [
        { title: 'D', url: `http://localhost:${s.port}/d` },
        { title: 'L', url: `http://localhost:${s.port}/l` },
      ],
      { onResult: (ch, r) => seen.push([ch.title, r.live]) },
    );
    s.stop(true);
    expect(seen).toEqual([
      ['D', false],
      ['L', true],
    ]);
  });
});
