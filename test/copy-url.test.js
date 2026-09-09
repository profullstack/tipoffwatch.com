import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { ChannelRow, SharedChannelRow } = await import('../apps/web/src/views/pages.jsx');
const { Multiview } = await import('../apps/web/src/views/multiview.jsx');
const { WatchChannel } = await import('../apps/web/src/views/watch.jsx');

/**
 * Copying the address of the thing you are watching.
 *
 * VLC and Infuse are deep links into two named apps, and app.js removes them on
 * a desktop because the schemes mean nothing there. The .m3u download is the
 * mirror image: right on a desktop, removed on a phone. So on any given device
 * one of the two ways to reach the stream is gone, and neither was ever any use
 * to mpv, ffmpeg, a set-top box, or a second player on another machine. An
 * address in the clipboard works everywhere.
 *
 * The rule that shapes all of it is the one that already governs VLC: the
 * address IS the credential. A managed row plays here and nowhere else, a shared
 * row is somebody else's subscription, and the multiview grid is rendered from
 * ids alone. Each of those keeps its property below.
 */

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');
const render = async (node) => String(await node.toString());

const APP_JS = read('../apps/web/public/app.js');
const SERVER = read('../apps/web/src/app.js');

const OWN = {
  id: 7,
  title: 'ESPN HD',
  group: 'USA',
  kind: 'live',
  url: 'http://line.example.test:8080/user/pass/1234',
  verified: true,
};

describe('a row on the reader own line', () => {
  test('offers the address the VLC link beside it already carries', async () => {
    const out = await render(ChannelRow({ ch: OWN }));
    expect(out).toContain(`data-copy-url="${OWN.url}"`);
    expect(out).toContain('Copy URL');
  });

  test('a film gets one too, because a VOD entry is a URL like any other', async () => {
    const out = await render(ChannelRow({ ch: { ...OWN, kind: 'vod', title: 'Heat (1995)' } }));
    expect(out).toContain(`data-copy-url="${OWN.url}"`);
    // The wording follows the row: "this file", not "this stream".
    expect(out).toContain('file');
  });

  /*
   * The whole reason this button is safe on a normal row is that the button
   * beside it already publishes the same string. Where that stops being true,
   * this has to stop with it.
   */
  test('a managed row gets none, for the reason it gets no VLC link', async () => {
    const out = await render(ChannelRow({ ch: { ...OWN, providerManaged: true } }));
    expect(out).not.toContain('data-copy-url');
    expect(out).not.toContain('vlc-x-callback');
  });

  test('a managed LIST is still managed when the flag comes as a prop', async () => {
    const out = await render(ChannelRow({ ch: OWN, managed: true }));
    expect(out).not.toContain('data-copy-url');
  });

  test('somebody else list gets none: that address is their subscription', async () => {
    const out = await render(SharedChannelRow({ ch: { id: 3, title: 'Sky', ownerLabel: 'Jo' } }));
    expect(out).not.toContain('data-copy-url');
  });
});

describe('the multiview grid', () => {
  const user = { id: 'u1', email: 'a@example.test', handle: 'a' };
  const tiles = [{ id: 11, title: 'ESPN', group: 'USA', kind: 'live' }];
  const page = () =>
    render(Multiview({ user, hasList: true, tiles, allowance: 2, maxTiles: 4, live: [] }));

  test('every tile offers a copy button, template included', async () => {
    const out = await page();
    // One on the rendered tile, one in the <template> the package clones for a
    // tile added on the page. Neither is wired per tile: app.js delegates.
    expect(out.match(/data-mv-copy/g)?.length).toBe(2);
  });

  /*
   * The property this page has always claimed, and the reason the button asks a
   * route instead of reading an attribute. A grid is bookmarked, reloaded and
   * popped out into a second window; a credential in its markup would travel
   * with all three.
   */
  test('and no address anywhere in the markup', async () => {
    const out = await page();
    expect(out).not.toContain('data-copy-url');
    expect(out).not.toContain('line.example.test');
    expect(out).toContain('/my/channels/11/stream.ts');
  });
});

describe('a news channel page', () => {
  const channel = { id: 'bbc-news', name: 'BBC News', country: 'UK', quality: 'HD' };

  test('offers the same playlist the player above it is reading', async () => {
    const out = await render(WatchChannel({ user: null, channel, also: [] }));
    expect(out).toContain('data-copy-url="/watch/bbc-news/index.m3u8"');
  });

  /*
   * Nothing here is a credential: /watch/:id/index.m3u8 takes no session, which
   * is exactly why the address is worth copying -- it plays in VLC as it plays
   * here. Written as a path because only the browser knows which brand it is on.
   */
  test('as a path, for app.js to make absolute', async () => {
    const out = await render(WatchChannel({ user: null, channel, also: [] }));
    expect(out).not.toContain('data-copy-url="http');
  });
});

describe('the route a tile asks', () => {
  test('exists, under /api so robots.txt already keeps crawlers off it', () => {
    expect(SERVER).toContain("app.get('/api/my/channels/:channelId/address'");
  });

  test('refuses a managed row rather than handing over our reseller credential', () => {
    const route = SERVER.slice(
      SERVER.indexOf("app.get('/api/my/channels/:channelId/address'"),
      SERVER.indexOf("app.get('/my/channels/:channelId/playlist.m3u'"),
    );
    expect(route).toContain('ch.managed');
    expect(route).toContain('403');
    // The body is a credential, so it must not be written into any cache.
    expect(route).toContain("'no-store, private'");
  });
});

describe('the browser half', () => {
  test('a literal address is copied, and made absolute first', () => {
    expect(APP_JS).toContain('function initCopyUrlButtons');
    expect(APP_JS).toContain('new URL(raw, window.location.href)');
  });

  test('a tile asks the route instead, on the press', () => {
    expect(APP_JS).toContain('function initMultiviewCopy');
    expect(APP_JS).toContain('/api/my/channels/${encodeURIComponent(id)}/address');
  });

  /*
   * Delegated at the document, which is what makes a tile added after load work
   * -- @profullstack/multiview stamps those out of the page's own template and
   * knows nothing about this button.
   */
  test('both are armed once, at the document', () => {
    expect(APP_JS).toContain('initCopyUrlButtons();');
    expect(APP_JS).toContain('initMultiviewCopy();');
  });

  /*
   * navigator.clipboard is absent outside a secure context and can be refused
   * inside one. A dead button that swallowed the address would be the worst of
   * the outcomes, so the URL goes into a field the reader can select.
   */
  test('a refused clipboard still puts the address in front of the reader', () => {
    expect(APP_JS).toContain('function revealAddress');
    expect(APP_JS).toContain('copy-url-fallback');
  });

  test('the player draws the button under the picture, from the row own address', () => {
    expect(APP_JS).toContain("copyBar.className = 'player-copy'");
    expect(APP_JS).toContain("row?.querySelector('[data-copy-url]')");
    // Torn down with the stage: it names the channel that stage is carrying.
    expect(APP_JS).toContain('copyBar?.remove();');
  });
});
