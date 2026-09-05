import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MAX_TILES, parseChannelIds } from '../apps/web/src/lib/multiview.js';
import { Multiview } from '../apps/web/src/views/multiview.jsx';
import { ChannelRow } from '../apps/web/src/views/pages.jsx';

/**
 * Several channels on one screen, from the reader's own line.
 *
 * Built because two event pages in two tabs could not both play: the proxy held
 * every account to one stream. With the allowance now the line's own (see
 * line-connections.test.js), this is the page that uses more than one of them
 * -- and the pop-out is the answer to "picture-in-picture for four games",
 * which the element-level API cannot do (one video per browser) and the
 * document-level one can.
 */

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');
const render = async (node) => String(await node.toString());

describe('the address', () => {
  test('is a list of channel row ids, in order', () => {
    expect(parseChannelIds('12,34,56')).toEqual([12, 34, 56]);
  });

  test('drops garbage rather than rejecting the link', () => {
    expect(parseChannelIds('12,abc,,0,-4,34')).toEqual([12, 34]);
    expect(parseChannelIds(undefined)).toEqual([]);
    expect(parseChannelIds('')).toEqual([]);
  });

  test('deduplicates and caps at the grid', () => {
    expect(parseChannelIds('1,1,2,2,3')).toEqual([1, 2, 3]);
    expect(parseChannelIds('1,2,3,4,5,6')).toEqual([1, 2, 3, 4]);
    expect(MAX_TILES).toBe(4);
  });

  test('tolerates spaces, which a hand-edited link has', () => {
    expect(parseChannelIds('1, 2 ,3')).toEqual([1, 2, 3]);
  });
});

describe('the page', () => {
  const user = { id: 'u1', email: 'a@example.test', handle: 'a' };
  const tiles = [
    { id: 11, title: 'NFL 01: Raiders vs Texans', group: 'NFL', kind: 'live' },
    { id: 12, title: 'ESPN', group: null, kind: 'live' },
  ];

  test('renders a tile per channel, playing through the proxy route', async () => {
    const html = await render(
      Multiview({ user, hasList: true, tiles, allowance: 2, panelConnections: 2, live: [] }),
    );
    expect(html).toContain('data-mv-tile-id="11"');
    expect(html).toContain('data-play="/my/channels/11/stream.ts"');
    expect(html).toContain('data-play="/my/channels/12/stream.ts"');
    expect(html).toContain('data-count="2"');
    expect(html).toContain('NFL 01: Raiders vs Texans');
  });

  test('tells the page what the line permits', async () => {
    const html = await render(
      Multiview({ user, hasList: true, tiles, allowance: 2, panelConnections: 2, live: [] }),
    );
    expect(html).toContain('data-max="2"');
    expect(html).toContain(
      'Your line permits 2 streams at once, which is what your provider reports.',
    );
  });

  test('says when the provider would not say, and when the reader lowered it', async () => {
    const quiet = await render(
      Multiview({ user, hasList: true, tiles, allowance: 1, panelConnections: null, live: [] }),
    );
    expect(quiet).toContain('Your provider did not say how many it allows');
    const lowered = await render(
      Multiview({ user, hasList: true, tiles, allowance: 1, panelConnections: 3, live: [] }),
    );
    expect(lowered).toContain('Your provider reports 3; you lowered it in settings.');
  });

  test('carries the player bundle under its own attribute, not the event page’s', async () => {
    // data-player-src is what initInlinePlayer walks; a multiview section under
    // that name would be handed to the wrong initialiser.
    const html = await render(
      Multiview({ user, hasList: true, tiles, allowance: 1, panelConnections: null, live: [] }),
    );
    expect(html).toContain('data-mv-player-src="/vendor-mpegts.js');
    expect(html).not.toContain('data-player-src=');
  });

  test('never carries a stream url', async () => {
    const html = await render(
      Multiview({
        user,
        hasList: true,
        tiles: [{ ...tiles[0], stream_url: 'sealed-secret', url: 'http://line/u/p/1' }],
        allowance: 1,
        panelConnections: null,
        live: [],
      }),
    );
    expect(html).not.toContain('sealed-secret');
    expect(html).not.toContain('http://line/u/p/1');
  });

  test('a reader with no list is sent to settings, and gets no grid', async () => {
    const html = await render(Multiview({ user, hasList: false, tiles: [], live: [] }));
    expect(html).toContain('Add one in settings');
    expect(html).not.toContain('data-mv-grid');
  });

  test('ships a template for tiles added on the page', async () => {
    const html = await render(
      Multiview({ user, hasList: true, tiles: [], allowance: 1, panelConnections: null, live: [] }),
    );
    expect(html).toContain('<template data-mv-tile');
    expect(html).toContain('data-count="0"');
    expect(html).toContain('No tiles yet');
  });

  test('the live list points at event pages, where the Multiview button is', async () => {
    const html = await render(
      Multiview({
        user,
        hasList: true,
        tiles: [],
        allowance: 1,
        panelConnections: null,
        live: [{ id: 99, short_name: 'LV @ HOU', name: 'Raiders at Texans', league_name: 'NFL' }],
      }),
    );
    expect(html).toContain('href="/events/99"');
    expect(html).toContain('LV @ HOU');
  });
});

describe('the Multiview button on a channel row', () => {
  test('is a plain link to a grid of one, marked for app.js to extend', async () => {
    const html = await render(
      ChannelRow({ ch: { id: 7, title: 'ESPN', url: 'http://line.example.test/u/p/7' } }),
    );
    expect(html).toContain('href="/multiview?c=7"');
    expect(html).toContain('data-multiview-add="7"');
    // A new window, and therefore outside the client-side navigation.
    expect(html).toContain('target="_blank"');
  });

  test('is not offered for a row with no id', async () => {
    const html = await render(
      ChannelRow({ ch: { title: 'ESPN', url: 'http://line.example.test/u/p/7' } }),
    );
    expect(html).not.toContain('/multiview');
  });
});

describe('the route', () => {
  const app = read('../apps/web/src/app.js');
  const route = app.slice(app.indexOf("app.get('/multiview'"));
  const body = route.slice(0, route.indexOf('\n});'));

  test('resolves every id through the owner-joined query', () => {
    expect(body).toContain('parseChannelIds(c.req.query(');
    expect(body).toContain('q.ownChannelById(user.id, id)');
  });

  test('is never cached: it names the reader’s own channels', () => {
    expect(body).toContain("c.header('cache-control', 'no-store, private')");
  });

  test('hands the view only what a tile needs', () => {
    expect(body).toContain(
      '.map((ch) => ({ id: ch.id, title: ch.title, group: ch.group_title, kind: ch.kind }))',
    );
    expect(body).not.toContain('stream_url');
  });

  test('the channel search answers only this account, without urls', () => {
    const search = app.slice(app.indexOf("app.get('/api/my/channels/search'"));
    const s = search.slice(0, search.indexOf('\n});'));
    expect(s).toContain('.searchOwnChannels(user.id');
    expect(s).toContain('normaliseTitle(term)');
    expect(s).not.toContain('stream_url');
  });

  test('the nav links to it for a signed-in reader', () => {
    expect(read('../apps/web/src/views/Layout.jsx')).toContain(
      '{props.user ? <a href="/multiview">Multiview</a> : null}',
    );
  });
});

describe('app.js', () => {
  const src = read('../apps/web/public/app.js');
  const fn = src.slice(src.indexOf('function initMultiview('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  test('runs at boot and after a client-side navigation', () => {
    expect(src.split('initMultiview();').length - 1).toBe(2);
    expect(src.split('initMultiviewAdd();').length - 1).toBe(2);
  });

  test('never starts a tile past the line’s allowance', () => {
    expect(body).toContain('if (running.size < allowance) return true;');
    // Reserved BEFORE the bundle is awaited, or four tiles starting together all
    // pass the count and all open.
    expect(body.indexOf('running.set(tile, { stop: null, video: null })')).toBeLessThan(
      body.indexOf('await loadPlayerBundle(src)'),
    );
  });

  test('tiles start muted, and sound is solo', () => {
    expect(body).toContain('video.muted = true;');
    expect(body).toContain('r.video.muted = t !== tile;');
  });

  test('pops out through Document Picture-in-Picture, by moving the grid', () => {
    expect(body).toContain('window.documentPictureInPicture.requestWindow(');
    expect(body).toContain('pip.document.body.append(grid)');
    // Stylesheets go by link, never inline: the window inherits the page's CSP.
    expect(body).toContain('link[rel="stylesheet"]');
    expect(body).not.toContain("createElement('style')");
    // And the grid comes home when the window closes.
    expect(body).toContain("pip.addEventListener('pagehide'");
    expect(body).toContain('stage.prepend(grid)');
  });

  test('falls back to a plain window, stopping this page’s streams first', () => {
    const fallback = body.slice(body.indexOf("window.open(location.href, 'tw-multiview'"));
    const before = body.slice(0, body.indexOf("window.open(location.href, 'tw-multiview'"));
    expect(fallback).toContain('popup');
    expect(before.trimEnd().endsWith('for (const t of tiles()) stopTile(t);')).toBe(true);
  });

  test('leaving drops every provider connection', () => {
    expect(body).toContain("window.addEventListener('pagehide', stopAll)");
    expect(body).toContain('window.__tipoffStopPlayer = () => {');
  });

  test('the event-page link carries the remembered tiles and remembers this one', () => {
    const add = src.slice(src.indexOf('function initMultiviewAdd('));
    const a = add.slice(0, add.indexOf('\n}\n'));
    expect(a).toContain("link.href = `/multiview?c=${withThis().join(',')}`");
    expect(a).toContain("link.addEventListener('click'");
    expect(a).toContain('saveMultiviewSet(withThis())');
  });

  test('a click on the picture is the sound control, and Play on a stopped tile', () => {
    const click = body.slice(body.indexOf("tile.querySelector('[data-mv-screen]')"));
    const handler = click.slice(0, click.indexOf('});'));
    expect(handler).toContain('if (running.has(tile)) toggleSound(tile);');
    expect(handler).toContain('else startTile(tile);');
    // The lit frame follows the sound, on the tile and not just the button.
    expect(body).toContain("tile.dataset.sound = on ? '1' : '';");
  });

  test('tiles are rearranged by pointer drag, against the tile’s own document', () => {
    expect(body).toContain("handle.addEventListener('pointerdown'");
    expect(body).toContain('handle.setPointerCapture(event.pointerId)');
    // After a pop-out the grid is in the PiP window; `document` would be the
    // page underneath it.
    expect(body).toContain('tile.ownerDocument');
    expect(body).toContain(
      "doc.elementFromPoint(event.clientX, event.clientY)?.closest('.mv-tile')",
    );
    // A finished drag is a new order, so the address and remembered set follow.
    const done = body.slice(body.indexOf('const done = () => {'));
    expect(done.slice(0, done.indexOf('};'))).toContain('sync();');
  });

  test('and by the arrow keys on the handle', () => {
    expect(body).toContain(
      'const delta = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];',
    );
    expect(body).toContain('moveTile(tile, delta);');
    const move = body.slice(body.indexOf('const moveTile = (tile, delta) => {'));
    expect(move.slice(0, move.indexOf('};'))).toContain('sync();');
  });

  test('names another Multiview window on this browser, without synchronising with it', () => {
    expect(body).toContain("new BroadcastChannel('tw.multiview')");
    expect(body).toContain("channel.postMessage({ type: 'hello', id: me })");
    expect(body).toContain("channel.postMessage({ type: 'here', id: me })");
    expect(body).toContain("channel.postMessage({ type: 'bye', id: me })");
    expect(body).toContain('Another Multiview window is open in this browser.');
    // Presence only: no tile ids ever cross the channel.
    const presence = body.slice(body.indexOf("'BroadcastChannel' in window"));
    expect(presence.slice(0, presence.indexOf('/* ---- go ---- */'))).not.toContain('ids()');
  });
});

describe('the tile', () => {
  const user = { id: 'u1', email: 'a@example.test', handle: 'a' };
  const tiles = [{ id: 11, title: 'ESPN', group: null, kind: 'live' }];

  test('has a drag handle and a clickable picture, both marked for app.js', async () => {
    const html = await render(
      Multiview({ user, hasList: true, tiles, allowance: 2, panelConnections: 2, live: [] }),
    );
    expect(html).toContain('data-mv-grab');
    expect(html).toContain('aria-label="Move this tile: drag it, or press the arrow keys"');
    expect(html).toContain('data-mv-screen');
    expect(html).toContain('title="Click for sound"');
    // The slot the other-window notice is written into, hidden by class and not
    // by the attribute (a styled element ignores `hidden`).
    expect(html).toContain('data-mv-others');
    expect(html).toContain('class="mv-others small is-hidden"');
  });

  test('says how the grid is worked', async () => {
    const html = await render(
      Multiview({ user, hasList: true, tiles, allowance: 2, panelConnections: 2, live: [] }),
    );
    expect(html).toContain('Click a');
    expect(html).toContain('tile to hear it, drag the ⋮⋮ handle to rearrange, ✕ to take one out.');
  });
});
