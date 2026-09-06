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

describe('app.js, which now only wires the package', () => {
  const src = read('../apps/web/public/app.js');

  /*
   * The grid itself moved to @profullstack/multiview, where its behaviour is
   * tested against a stub browser. What is worth pinning HERE is the contract
   * between the site and the package -- the three things that would silently
   * break the page if they drifted, and which the package cannot check for
   * itself because they are the host's to supply.
   */

  test('loads the package rather than carrying its own copy', () => {
    expect(src).toContain("import('/vendor-multiview.js')");
    // The six hundred lines really are gone, not merely unused.
    expect(src).not.toContain('function initMultiview(');
    expect(src).not.toContain('data-mv-popout');
    expect(src).not.toContain('documentPictureInPicture');
  });

  test('names the storage key and the player global, which are the host’s', () => {
    expect(src).toContain("storageKey: 'tw.multiview'");
    // The SAME global the single-stream player uses, so a page carrying both
    // fetches the quarter-megabyte demuxer once rather than twice.
    expect(src).toContain("playerGlobal: '__tipoffPlayer'");
    expect(src).toContain('window.__tipoffPlayer');
  });

  test('fetches it only on a page that needs it', () => {
    const fn = src.slice(src.indexOf('function initMultiviewFeature('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("root.querySelector('[data-multiview]')");
    expect(body).toContain("root.querySelector('a[data-multiview-add]')");
    expect(body).toContain('if (!needed) return;');
    // A grid that fails to load leaves the page a reader without JavaScript
    // has always had, so the failure is swallowed rather than announced.
    expect(body).toContain('.catch(');
  });

  test('runs at boot and after a client-side navigation', () => {
    expect(src.split('initMultiviewFeature();').length - 1).toBe(2);
  });

  test('the promise is cached, so one navigation does not fetch it twice', () => {
    expect(src).toContain('if (!multiviewModule) {');
  });

  test('the stylesheet comes from the package too', () => {
    expect(read('../apps/web/src/views/multiview.jsx')).toContain(
      '<link rel="stylesheet" href="/vendor-multiview.css" />',
    );
    // And the site's own stylesheet no longer carries a copy to drift.
    expect(read('../apps/web/public/styles.css')).not.toContain('.mv-tile {');
  });

  test('both package files are served, resolved through node_modules', () => {
    const app = read('../apps/web/src/app.js');
    expect(app).toContain("['/vendor-multiview.js', '@profullstack/multiview', 'text/javascript']");
    expect(app).toContain(
      "['/vendor-multiview.css', '@profullstack/multiview/multiview.css', 'text/css']",
    );
    // Resolved at boot: a missing dependency should stop the container, not
    // 404 a file the page cannot work without.
    expect(app).toContain('import.meta.resolve(spec)');
  });

  test('the package is a real dependency, so the lockfile pins the bytes', () => {
    const pkg = JSON.parse(read('../package.json'));
    const web = JSON.parse(read('../apps/web/package.json'));
    const deps = { ...pkg.dependencies, ...web.dependencies };
    expect(deps['@profullstack/multiview']).toBeTruthy();
  });
});

describe('the “Where to watch” rows', () => {
  /*
   * These rows are hand-rolled rather than ChannelRow, because they pair a
   * broadcaster listing with the reader's own entry -- and that copy drifted
   * from the component it was copied from. Twice: it never gained the Multiview
   * button, and it never gained the managed-list rule, so a pass holder was
   * being offered VLC and .m3u links carrying our reseller credential.
   */
  const src = read('../apps/web/src/views/pages.jsx');
  const fn = src.slice(src.indexOf('const BroadcastMarkets = ('));
  const body = fn.slice(0, fn.indexOf('\n};\n'));

  test('offer Multiview, like every other playable row', () => {
    expect(body).toContain('data-multiview-add={ch.id}');
    expect(body).toContain('href={`/multiview?c=${ch.id}`}');
  });

  test('withhold the credential-bearing links on a managed list', () => {
    expect(body).toContain('{managed ? null : (');
    expect(body).toContain('playerLinks(ch.url).vlc');
    expect(body).toContain('/playlist.m3u`}');
    // The flag has to actually reach the section.
    expect(src).toContain('managed={Boolean(ownChannels?.managed)}');
  });

  test('still play through the proxy, which needs no credential', () => {
    expect(body).toContain('data-play={`/my/channels/${ch.id}/stream.ts`}');
  });
});
