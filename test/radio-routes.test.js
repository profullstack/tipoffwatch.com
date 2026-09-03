import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';

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
    expect(src).toContain('`/radio/proxy?u=${encodeURIComponent(target)}');
    const resource = src.slice(src.indexOf('function radioResource'));
    expect(resource.slice(0, 2000)).toContain("'cache-control': 'no-store, private'");
  });

  test('a wrong code keeps the sign-in; an expired one says so', async () => {
    const src = await read('../apps/web/src/app.js');
    const verify = src.slice(src.indexOf("app.post('/api/radio/connect/verify'"));
    expect(verify.slice(0, 2500)).toContain('if (status === 400) radio.putPending(user.id, pending)');
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

  test('app.js wires the radio sections at boot and after a client-side navigation', async () => {
    const client = await read('../apps/web/public/app.js');
    expect(client).toContain('function initRadio(');
    expect(client.match(/^initRadio\(\);/m)).not.toBeNull();
    const nav = client.slice(client.indexOf('function initNavigation'), client.indexOf('function initNavigation') + 2500);
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
