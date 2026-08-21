import { describe, expect, test } from 'bun:test';
import { firstLiveChannel, probeStream } from '../packages/playlists/src/probe.js';

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
