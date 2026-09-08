import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { ChannelRow } = await import('../apps/web/src/views/pages.jsx');

const render = async (node) => (node == null ? '' : (await node.toString()).toString());

const read = (rel) => readFile(new URL(rel, import.meta.url).pathname, 'utf8');

/**
 * A channel row now belongs to one of several lines, and which line decides what
 * the row may hand over. These are the failures that would follow from getting
 * that wrong, which are not symmetrical: one of them publishes our credential.
 */
describe('a row from a managed line', () => {
  const managedRow = {
    id: 7,
    title: 'Sky Sports Main Event',
    url: 'http://line.example/live/user/pass/1.ts',
    providerLabel: 'TipoffWatch Live TV',
    providerManaged: true,
  };
  const ownRow = { ...managedRow, id: 8, providerLabel: 'My provider', providerManaged: false };

  /*
   * The reason this matters more than the converse: on our managed line the
   * stream address IS our reseller credential, and VLC, Infuse and the .m3u
   * download each hand it over. Rendered inside a list of the reader's own
   * channels -- which is what a merged, multi-provider list is -- a section-level
   * flag would say "not managed" and publish it.
   */
  test('withholds the credential-bearing links even in an unmanaged list', async () => {
    const out = await render(ChannelRow({ ch: managedRow, managed: false }));
    expect(out).not.toContain('playlist.m3u');
    expect(out).not.toContain('vlc://');
    // The provider address itself, which is the actual credential: the path
    // carries the line's username and password. Asserted on the host rather than
    // on ".ts", which also matches /my/channels/7/stream.ts -- our own proxy
    // route, which hands over nothing and is meant to be there.
    expect(out).not.toContain('line.example');
    expect(out).not.toContain('user/pass');
  });

  test("a row from the reader's own line keeps them", async () => {
    const out = await render(ChannelRow({ ch: ownRow, managed: false }));
    expect(out).toContain('playlist.m3u');
  });

  /* The section-level prop still wins where a page passes one. */
  test('a section marked managed still withholds them from every row', async () => {
    const out = await render(ChannelRow({ ch: ownRow, managed: true }));
    expect(out).not.toContain('playlist.m3u');
  });

  test('names which line the row is on', async () => {
    expect(await render(ChannelRow({ ch: ownRow }))).toContain('My provider');
  });

  /*
   * A reader with one provider would otherwise see the same tag on every row,
   * repeating an answer they cannot act on.
   */
  test('says nothing when the row does not know its line', async () => {
    const out = await render(ChannelRow({ ch: { id: 9, title: 'X', url: 'http://a/b.ts' } }));
    expect(out).not.toContain('channel-tag provider');
  });
});

describe('the queries that fan out', () => {
  test('candidates carry the line each entry is on', async () => {
    const src = await read('../packages/db/src/queries.js');
    const fn = src.slice(
      src.indexOf('export async function playlistCandidates'),
      src.indexOf('export async function markChannelChecked'),
    );
    expect(fn).toContain('p.id as playlist_id');
    expect(fn).toContain('p.label as playlist_label');
    expect(fn).toContain('p.managed as playlist_managed');
    /*
     * Positions restart at zero per list, so ordering by the channel's position
     * alone stopped being deterministic the moment a reader could have two lines:
     * entry 3 of each would interleave however the planner felt, and the LIMIT
     * would keep whichever came out first.
     */
    // Asserted as the INVARIANT rather than one spelling of it. The clause is
    // now `order by playlist_position, playlist_id, rn` because the statement
    // windows per list first -- same ordering, aliased through a subquery, since
    // a 1.4M-entry list could otherwise take the whole LIMIT before the reader's
    // other provider was read at all.
    expect(fn).toMatch(
      /order by (p\.position, p\.id, c\.position|playlist_position, playlist_id, rn)/,
    );
    // Whichever spelling, the reader's provider order leads and the tie is broken
    // inside the list -- never by the channel's position alone, which restarts at
    // zero per list.
    expect(fn).toMatch(/order by (p\.position|playlist_position)/);
  });

  /*
   * The write path is where a mistake corrupts rather than merely confuses. Each
   * of these used to mean "the reader's list" and would now silently act on their
   * FIRST one, so an import into a second provider would wipe the first.
   */
  test('every channel and status write can name its list', async () => {
    const src = await read('../packages/db/src/queries.js');
    for (const fn of [
      'replacePlaylistChannels',
      'markPlaylistError',
      'markPlaylistFresh',
      'savePlaylist',
      'setPlaylistManaged',
    ]) {
      const at = src.indexOf(`export async function ${fn}(`);
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(at, at + 400)).toContain('playlistId');
    }
  });

  /*
   * The rule this file states about itself: ownership is part of the lookup, so
   * there is no query that takes a playlist id without the user it belongs to.
   */
  test('no lookup takes a playlist id on its own', async () => {
    const src = await read('../packages/db/src/queries.js');
    expect(src).not.toContain('export async function getPlaylistById');
    const at = src.indexOf('export async function getPlaylistFor(');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 320);
    expect(body).toContain('user_id = ${userId}');
    expect(body).toContain('id = ${playlistId}');
  });
});

describe('the refresh poller', () => {
  /*
   * The sharpest edge in this whole change. importPlaylist ADDS a list when it is
   * given no id, so a refresh that omitted one would insert a fresh row on every
   * cycle: the five-minute poller would manufacture a duplicate list per tick,
   * each re-fetching the same provider, until the account hit the cap. Nothing
   * would have looked wrong until the settings page filled up.
   */
  test('a refresh edits its list rather than adding one', async () => {
    const src = await read('../packages/playlists/src/index.js');
    const at = src.indexOf('export async function refreshPlaylist');
    const body = src.slice(at, at + 1400);
    expect(body).toContain('playlistId: row.id');
  });

  test('the due query returns the id the refresh needs', async () => {
    const src = await read('../packages/db/src/queries.js');
    const at = src.indexOf('export async function playlistsDueForRefresh');
    expect(src.slice(at, at + 500)).toContain('select id, user_id');
  });

  test('the worker refreshes each due list, not the first one repeatedly', async () => {
    const src = await read('../packages/playlists/src/index.js');
    const at = src.indexOf('export async function refreshDuePlaylists');
    expect(src.slice(at, at + 2200)).toContain('playlistId: row.id');
  });
});

describe('the live pass', () => {
  /*
   * The pass used to take the reader's row, park their address in a stash column
   * and hand it back on lapse. Paying us therefore cost them access to their own
   * subscription for the length of the pass. Now it adds a row beside theirs.
   */
  test('adds a line beside the reader’s own rather than taking theirs', async () => {
    const src = await read('../packages/live/src/index.js');
    expect(src).not.toContain('stashedSourceUrl');
    expect(src).not.toContain('stashed_source_url');
    expect(src).toContain('managedPlaylistFor');
    // Marked by the id the import returned, never by falling back to their first
    // list -- which is very likely one of their own.
    expect(src).toContain('playlistId: result?.playlistId ?? null');
  });

  test('a lapse removes only the line the pass added', async () => {
    const src = await read('../packages/live/src/index.js');
    const at = src.indexOf('export async function reconcileLapsed');
    const body = src.slice(at, at + 1200);
    // deletePlaylist with no id still means every list this reader has.
    expect(body).toContain('deletePlaylist(row.user_id, row.playlist_id)');
  });
});

describe('the settings surface', () => {
  test('remove names the list it removes', async () => {
    const src = await read('../apps/web/src/views/pages.jsx');
    const at = src.indexOf('action="/api/playlist/delete"');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 420)).toContain('name="playlist_id"');
  });

  /*
   * The route refuses an id-less delete rather than falling back to "all of
   * them", which is right for closing an account and catastrophic for a button.
   */
  test('the route refuses a delete that names no list', async () => {
    const src = await read('../apps/web/src/app.js');
    const at = src.indexOf("app.post('/api/playlist/delete'");
    const body = src.slice(at, at + 1500);
    expect(body).toContain('if (!playlistId)');
    expect(body).toContain('getPlaylistFor');
  });

  test('adding a list is capped', async () => {
    const src = await read('../apps/web/src/app.js');
    expect(src).toContain('MAX_PLAYLISTS');
    const at = src.indexOf('const MAX_PLAYLISTS');
    expect(at).toBeGreaterThan(-1);
    // The cap applies to adding, never to editing one that exists -- or a reader
    // at the limit could not fix a typo in an address.
    expect(src).toContain('if (!playlistId && (await q.playlistCount(user.id)) >= MAX_PLAYLISTS)');
  });
});
