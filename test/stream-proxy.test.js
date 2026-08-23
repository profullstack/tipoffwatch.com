import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { _resetStreamSlots, claimStreamSlot, openStream } from '../packages/playlists/src/proxy.js';

/**
 * Playing a channel in the page, for a device with no app to hand it to.
 *
 * A television has a browser and nothing else: no VLC to deep link into, no
 * Infuse, no filesystem for an .m3u. The bytes therefore come through the server
 * for that one case, and the risks are all in the edges rather than the happy
 * path -- a dead slot that answers 200 with a web page, a reader who closes the
 * tab, a second tab opening a second connection on a line that permits one.
 *
 * A local server stands in for the provider, so none of this touches anybody's
 * subscription.
 */

/** A server that answers each path with a fixed shape. */
function serve(routes) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const r = routes[pathname];
      if (!r) return new Response('nope', { status: 404 });
      if (r.hang) return new Promise(() => {});
      return new Response(r.body ?? 'x', {
        status: r.status ?? 200,
        headers: r.type ? { 'content-type': r.type } : {},
      });
    },
  });
}

describe('opening a channel for the browser', () => {
  test('a transport stream comes back with its body intact', async () => {
    const s = serve({ '/ts': { type: 'video/mp2t', body: 'GG' } });
    const got = await openStream(`http://localhost:${s.port}/ts`);
    expect(got.ok).toBe(true);
    // The body has to be the actual stream, not a buffered copy or a summary:
    // this route exists to pass bytes through.
    expect(await new Response(got.body).text()).toBe('GG');
    s.stop(true);
  });

  test('a dead slot answering 200 with a web page is refused, in its own words', async () => {
    // The common failure on these panels, and the reason a status code is not
    // enough on its own. Handing this to the player produces a decoder error,
    // which reads as "your player is broken" rather than "that slot is empty".
    const s = serve({ '/dead': { type: 'text/html; charset=UTF-8', body: '<html>gone' } });
    const got = await openStream(`http://localhost:${s.port}/dead`);
    expect(got.ok).toBe(false);
    expect(got.status).toBe(502);
    expect(got.note).toContain('web page');
    s.stop(true);
  });

  test('an HLS playlist is refused as needing a different player, not as broken', async () => {
    // Playable, but not by this page: the transmuxer reads transport stream. The
    // distinction matters because the honest answer is "open it in VLC", and a
    // generic failure would not say that.
    const s = serve({ '/hls': { type: 'application/vnd.apple.mpegurl' } });
    const got = await openStream(`http://localhost:${s.port}/hls`);
    expect(got.ok).toBe(false);
    expect(got.status).toBe(415);
    expect(got.note).toContain('HLS');
    s.stop(true);
  });

  test('an error status names the status, so the reader knows it was the provider', async () => {
    const s = serve({ '/err': { status: 503, type: 'video/mp2t' } });
    const got = await openStream(`http://localhost:${s.port}/err`);
    expect(got.ok).toBe(false);
    expect(got.note).toContain('503');
    s.stop(true);
  });

  test('a provider that never answers gives up, rather than holding the request open', async () => {
    const s = serve({ '/hang': { hang: true } });
    const got = await openStream(`http://localhost:${s.port}/hang`, { connectTimeoutMs: 150 });
    expect(got.ok).toBe(false);
    expect(got.note).toBe('timed out');
    s.stop(true);
  });

  test('a reader who left is not recorded as a broken channel', async () => {
    /*
     * The distinction this exists for. Closing the tab aborts the request, and
     * treating that as a verdict would mark a perfectly good channel dead --
     * after which the page stops offering it, and the reader concludes the
     * feature is broken because they closed a tab.
     */
    const s = serve({ '/hang': { hang: true } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const got = await openStream(`http://localhost:${s.port}/hang`, { signal: ac.signal });
    expect(got.ok).toBe(false);
    expect(got.silent).toBe(true);
    s.stop(true);
  });

  test('something that is not a URL is refused without a fetch', async () => {
    const got = await openStream('not-a-url');
    expect(got.ok).toBe(false);
    expect(got.note).toContain('url');
  });
});

describe('one connection per account', () => {
  /*
   * Not our capacity: the reader's. A provider line permits a small number of
   * simultaneous connections, often exactly one, and exceeding it is what gets a
   * subscription suspended. Being told "you are already watching" is a better
   * outcome for the account holder than losing the account.
   */

  test('a second stream is refused while the first is open', () => {
    _resetStreamSlots();
    expect(claimStreamSlot('u1')).toBeTruthy();
    expect(claimStreamSlot('u1')).toBeNull();
  });

  test('another account is unaffected', () => {
    _resetStreamSlots();
    claimStreamSlot('u1');
    expect(claimStreamSlot('u2')).toBeTruthy();
  });

  test('releasing lets the next one through', () => {
    _resetStreamSlots();
    const release = claimStreamSlot('u1');
    release();
    expect(claimStreamSlot('u1')).toBeTruthy();
  });

  test('releasing twice does not hand out a slot that was never given back', () => {
    /*
     * Teardown fires on both cancel and error for the same viewer, so a double
     * release is the normal case rather than a rare one. Counting it twice walks
     * the number below zero and the cap silently stops applying -- which is the
     * shape of bug that only shows up as a suspended subscription.
     */
    _resetStreamSlots();
    const release = claimStreamSlot('u1');
    release();
    release();
    expect(claimStreamSlot('u1')).toBeTruthy();
    expect(claimStreamSlot('u1')).toBeNull();
  });

  test('the ceiling is configurable, for a line that permits more', () => {
    _resetStreamSlots();
    expect(claimStreamSlot('u1', { max: 2 })).toBeTruthy();
    expect(claimStreamSlot('u1', { max: 2 })).toBeTruthy();
    expect(claimStreamSlot('u1', { max: 2 })).toBeNull();
  });
});

describe('what the page offers, and to whom', () => {
  const view = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );
  const client = readFileSync(
    new URL('../apps/web/public/app.js', import.meta.url).pathname,
    'utf8',
  );

  test('Play here is offered for both a fixture channel and a competition one', () => {
    expect(view).toContain('stream.ts?${series');
    expect(view).toContain('<PlayButton eventId={event.id} index={i} />');
    expect(view).toContain('<PlayButton eventId={event.id} index={i} series />');
  });

  test('the app hand-offs survive alongside it', () => {
    // The whole point of the button being an addition: iPhone Safari cannot use
    // it, and VLC there is not a fallback but the primary route.
    expect(view).toContain('vlc-x-callback://x-callback-url/stream?url=');
    expect(view).toContain('infuse://x-callback-url/play?url=');
    expect(view).toContain('playlist.m3u?n=');
  });

  test('the button ships disabled, so a browser that cannot play never shows a live one', () => {
    expect(view).toMatch(/class="ghost small-btn play-btn"\s*\n\s*disabled/);
  });

  test('the button carries the proxy route and never the provider URL', () => {
    // The credential is in the VLC href because an external app holds no session
    // with us. The page does, so nothing here needs it -- and a URL in a
    // data-attribute would additionally sit in the DOM for any extension to read.
    expect(view).toMatch(/data-play=\{`\/events\/\$\{eventId\}\/stream\.ts/);
    expect(view).not.toMatch(/data-play=\{playerLinks/);
  });

  test('a browser with no Media Source Extensions loses the button entirely', () => {
    // iPhone Safari. A "Play here" that silently fails would pull people away
    // from VLC, which is the button that actually works there.
    expect(client).toContain('if (!canTransmux()) {');
    expect(client).toContain('for (const b of buttons) b.remove();');
  });

  test('the demuxer is fetched on demand, not linked from the Layout', () => {
    // A quarter of a megabyte on every event page, for the few who press play.
    const layout = readFileSync(
      new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(layout).not.toContain('vendor-mpegts.js');
    expect(view).toContain("data-player-src={assetUrl('vendor-mpegts.js')}");
  });

  test('navigating away stops the stream rather than orphaning it', () => {
    /*
     * The client-side navigation replaces <main> wholesale. A player whose
     * <video> has left the document keeps pulling the stream and holding the
     * account's one connection, so the next channel is refused with "you are
     * already watching" on a page showing no player at all.
     */
    expect(client).toContain('window.__tipoffStopPlayer?.();');
    expect(client).toContain("window.addEventListener('pagehide', teardown)");
  });
});
