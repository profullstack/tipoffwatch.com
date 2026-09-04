import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

/*
 * Shape assertions on the routes, for the properties that a session-less test
 * cannot exercise and that must never regress: the proxy checks the host
 * before it fetches, the bearer never reaches a response, and the client wires
 * the section the server renders.
 */
const read = (p) => readFile(new URL(p, import.meta.url).pathname, 'utf8');

describe('radio routes', () => {
  test('the proxy refuses a foreign host before any fetch, and every route needs a session', async () => {
    const src = await read('../apps/web/src/app.js');
    const proxy = src.slice(src.indexOf("app.get('/radio/proxy'"));
    const guard = proxy.indexOf('isSiriusXmUrl');
    const fetchAt = proxy.indexOf('radioFetch(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fetchAt);
    for (const route of [
      "app.post('/api/radio/connect'",
      "app.post('/api/radio/connect/verify'",
      "app.post('/api/radio/disconnect'",
      "app.get('/radio/find'",
      "app.get('/radio/stream.m3u8'",
      "app.get('/radio/proxy'",
    ]) {
      const body = src.slice(src.indexOf(route), src.indexOf(route) + 400);
      expect(body).toContain('requireUser(c)');
    }
  });

  test('a manifest leaves with root-relative proxy addresses and no-store', async () => {
    const src = await read('../apps/web/src/app.js');
    expect(src).toMatch(/`\/radio\/proxy\?u=\$\{encodeURIComponent\(target\)\}/);
    const resource = src.slice(src.indexOf('function radioResource'));
    expect(resource.slice(0, 2000)).toContain("'cache-control': 'no-store, private'");
  });

  test('there is no password route: the flow is email and code, as media-streamer', async () => {
    const src = await read('../apps/web/src/app.js');
    expect(src).not.toContain('/api/radio/connect/password');
    expect(src).not.toContain('passwordLogin(');
  });

  test('a wrong code keeps the sign-in; an expired one says so', async () => {
    const src = await read('../apps/web/src/app.js');
    const verify = src.slice(src.indexOf("app.post('/api/radio/connect/verify'"));
    expect(verify.slice(0, 2500)).toContain(
      'if (status === 400) radio.putPending(user.id, pending)',
    );
    expect(verify.slice(0, 2500)).toContain('That code has expired');
  });

  test('the player bundle and its stylesheet are served, versioned, and built', async () => {
    const src = await read('../apps/web/src/app.js');
    expect(src).toContain("['/vendor-player.js', 'vendor-player.js', 'text/javascript']");
    expect(src).toContain("['/vendor-player.css', 'vendor-player.css', 'text/css']");
    const build = await read('../apps/web/build-client.js');
    expect(build).toContain("['radio-entry.js', 'vendor-player.js']");
    expect(build).toContain('vendor-player.css');
    // The demuxer stays out of the radio bundle.
    expect(build).toContain("external: ['mpegts.js']");
  });

  test('the stored session is read on its own line, never slotted into a Promise.all', async () => {
    // It was, one position off from its destructuring, and every reader was
    // told they were connected -- the share-candidates list is truthy.
    const src = await read('../apps/web/src/app.js');
    for (const route of [
      "app.get('/settings'",
      "app.get('/events/:id'",
      '/:slug`, async (c) => {',
    ]) {
      const at = src.indexOf(route);
      expect(at).toBeGreaterThan(-1);
      const body = src.slice(at, at + 4000);
      const arrays = [...body.matchAll(/Promise\.all\(\[([\s\S]*?)\]\)/g)].map((m) => m[1]);
      for (const arr of arrays) expect(arr).not.toContain('radio.storedSession');
      expect(body).toMatch(/radioSession[\s\S]{0,120}await radio\.storedSession/);
    }
  });

  test('the team lookup is gated on a league with team feeds, for a fixture and for a team', async () => {
    const src = await read('../apps/web/src/app.js');
    const find = src.slice(src.indexOf("app.get('/radio/find'"));
    expect(find.slice(0, 2500)).toContain('radio.hasTeamRadio(leagueSlug)');
    expect(find.slice(0, 2500)).toContain("c.req.query('event')");
    expect(find.slice(0, 2500)).toContain("c.req.query('team')");
    // The pages draw the section only for those leagues, and never look up at render.
    expect(src).toContain('radio.hasTeamRadio(event.league_slug)');
    expect(src).toContain('radio.hasTeamRadio(team.league_slug)');
    expect(src.match(/radio\.sidesStations\(/g)).toHaveLength(1);
  });

  test('app.js looks the feeds up as soon as the section is on the page', async () => {
    const client = await read('../apps/web/public/app.js');
    const radio = client.slice(client.indexOf('function initRadioSection'));
    expect(radio).toContain('section.dataset.radioFind');
    expect(radio).toContain('look();');
    expect(radio).toContain("retry.textContent = 'Try again'");
  });

  test('app.js wires the radio sections at boot and after a client-side navigation', async () => {
    const client = await read('../apps/web/public/app.js');
    expect(client).toContain('function initRadio(');
    expect(client.match(/^initRadio\(\);/m)).not.toBeNull();
    const nav = client.slice(
      client.indexOf('function initNavigation'),
      client.indexOf('function initNavigation') + 2500,
    );
    expect(nav).toContain('initRadio();');
    // One stream per reader, across TV and radio alike.
    const radio = client.slice(client.indexOf('function initRadioSection'));
    expect(radio).toContain('window.__tipoffStopPlayer = () => {');
    expect(radio).toContain("window.addEventListener('pagehide', teardown)");
  });

  test('the bundle asks the house player for the audio bar', async () => {
    const entry = await read('../apps/web/src/client/radio-entry.js');
    expect(entry).toContain("import { createPlayer } from '@profullstack/player'");
    expect(entry).toContain('audio: true');
    expect(entry).toContain("kind: 'hls'");
    expect(entry).toContain('live: true');
  });
});

/*
 * A line opened to others: the same shape as a shared playlist, with the same
 * guards in the same order, and with the owner's session never reaching anybody.
 */
describe('sharing a SiriusXM line', () => {
  test('the schema mirrors the shared playlists: three audiences, agreeing flag, named grants', async () => {
    const sql = await read('../packages/db/migrations/0031_shared_siriusxm.sql');
    expect(sql).toContain("(shared and share_audience in ('friends', 'everyone'))");
    expect(sql).toContain("or (not shared and share_audience = 'none')");
    expect(sql).toContain('create table if not exists siriusxm_share_grants');
    expect(sql).toContain('references siriusxm_sessions(user_id) on delete cascade');
  });

  test("every read of somebody else's line is authorised by the shared row, viewer in hand", async () => {
    const queries = await read('../packages/db/src/queries.js');
    for (const fn of [
      'setSiriusXmSharing',
      'siriusXmShareCandidates',
      'setSiriusXmShareGrant',
      'sharedSiriusXmOwners',
      'sharedSiriusXmOwner',
    ]) {
      expect(queries).toContain(`export async function ${fn}(`);
    }
    const owner = queries.slice(queries.indexOf('export async function sharedSiriusXmOwner('));
    expect(owner.slice(0, 1500)).toContain('s.shared');
    expect(owner.slice(0, 1500)).toContain("s.share_audience = 'everyone'");
    expect(owner.slice(0, 1500)).toContain('g.audience_user_id = ${viewerId}::uuid');
    // Never the bearer or the jar: the columns a listener's request can reach.
    expect(owner.slice(0, 1500)).not.toContain('access_token');
    expect(owner.slice(0, 1500)).not.toContain('session_cookies');
  });

  test('the shared stream and proxy need a session, authorise before they fetch, and play as the owner', async () => {
    const src = await read('../apps/web/src/app.js');
    for (const route of [
      "app.get('/radio/shared/:owner/stream.m3u8'",
      "app.get('/radio/shared/:owner/proxy'",
      "app.post('/api/radio/share'",
      "app.post('/api/radio/share/grant'",
    ]) {
      const at = src.indexOf(route);
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(at, at + 400)).toContain('requireUser(c)');
    }
    for (const route of [
      "app.get('/radio/shared/:owner/stream.m3u8'",
      "app.get('/radio/shared/:owner/proxy'",
    ]) {
      const body = src.slice(src.indexOf(route), src.indexOf(route) + 1500);
      const authAt = body.indexOf('q.sharedSiriusXmOwner(');
      const fetchAt = body.indexOf('radioFetch(');
      expect(authAt).toBeGreaterThan(-1);
      expect(authAt).toBeLessThan(fetchAt);
      // The owner's line, the owner's proxy, the owner's addresses.
      expect(body).toContain('radioFetch(owner.owner_id');
      expect(body).toContain('lineUserId: owner.owner_id');
      expect(body).toContain('proxyUrl: radioSharedProxyUrl(owner.owner_id)');
    }
    // The shared proxy checks the host before it even looks the owner up.
    const proxy = src.slice(src.indexOf("app.get('/radio/shared/:owner/proxy'"));
    expect(proxy.indexOf('isSiriusXmUrl')).toBeLessThan(proxy.indexOf('q.sharedSiriusXmOwner('));
    // A shared manifest points back at the shared proxy, under its owner.
    expect(src).toContain(
      '`/radio/shared/${encodeURIComponent(ownerId)}/proxy?u=${encodeURIComponent(target)}',
    );
  });

  test('naming people is premium; narrowing never is', async () => {
    const src = await read('../apps/web/src/app.js');
    const share = src.slice(
      src.indexOf("app.post('/api/radio/share'"),
      src.indexOf("app.post('/api/radio/share'") + 1500,
    );
    expect(share).toContain("audience === 'friends' && !(await isMember(user))");
    const grant = src.slice(src.indexOf("app.post('/api/radio/share/grant'"));
    expect(grant.slice(0, 1200)).toContain('allowed && !(await isMember(user))');
  });

  test('a follower with no line lands on the shared one, on /radio and on a game page', async () => {
    const src = await read('../apps/web/src/app.js');
    const page = src.slice(src.indexOf("app.get('/radio',"), src.indexOf("app.get('/radio/find'"));
    expect(page).toContain('q.sharedSiriusXmOwners({ viewerId: user.id })');
    expect(page).toContain("c.req.query('via')");
    expect(page).toContain('radio.channels(lineUserId, cat)');
    // The fixture and team pages ask the same question, on their own line each.
    expect(src.match(/await radioSharedOwnerFor\(user\.id, radioSession\)/g)).toHaveLength(2);
    const find = src.slice(
      src.indexOf("app.get('/radio/find'"),
      src.indexOf("app.get('/radio/stream.m3u8'"),
    );
    expect(find).toContain("c.req.query('via')");
    expect(find).toContain('radio.sidesStations(lineUserId');
    expect(find).toContain('playBase={via ? radioSharedStreamUrl(via.owner_id) : undefined}');
  });

  test('the rows carry the play address they were rendered for', async () => {
    const view = await read('../apps/web/src/views/radio.jsx');
    expect(view).toContain("const OWN_PLAY_BASE = '/radio/stream.m3u8'");
    expect(view).toContain(
      'data-radio-play={`${playBase}?id=${encodeURIComponent(ch.stationId)}`}',
    );
    expect(view).toContain('/radio/shared/${encodeURIComponent(via.owner_id)}/stream.m3u8');
    // The settings card posts to the radio share routes, not the playlist ones.
    expect(view).toContain('action="/api/radio/share"');
    expect(view).toContain('action="/api/radio/share/grant"');
    // Never a VLC link, never an .m3u: those are the bearer.
    expect(view).not.toContain('vlc://');
    expect(view).not.toContain('.m3u"');
  });
});
