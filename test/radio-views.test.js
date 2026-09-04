import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';
process.env.PLAYLIST_SECRET ??= 'test-secret-for-sealing-values';
process.env.SITE_URL ??= 'https://tipoffwatch.com';

const { RadioChannelRow, RadioPage, RadioSettings, RadioSidesFragment, RadioTeamSection } =
  await import('../apps/web/src/views/radio.jsx');
const { Layout } = await import('../apps/web/src/views/Layout.jsx');

const html = (node) => node.toString();

const ch = {
  id: 'e1',
  type: 'channel-linear',
  number: 80,
  title: 'ESPN Radio',
  description: 'Sports talk',
  image: 'https://imgsrv-sxm-prod-device.streaming.siriusxm.com/abc',
  stationId: 'sxm:channel-linear:e1',
};

describe('RadioChannelRow', () => {
  test('carries the station on the button and never an SXM address', () => {
    const out = html(RadioChannelRow({ ch }));
    expect(out).toContain('data-radio-play="/radio/stream.m3u8?id=sxm%3Achannel-linear%3Ae1"');
    expect(out).toContain('Ch 80');
    expect(out).toContain('ESPN Radio');
    // Disabled until app.js has asked whether this browser can play HLS.
    expect(out).toMatch(/<button[^>]*disabled/);
    expect(out).not.toContain('siriusxm.com/playback');
    expect(out).not.toContain('VLC');
  });
  test('a channel without art gets a placeholder, not a broken image', () => {
    const out = html(RadioChannelRow({ ch: { ...ch, image: null } }));
    expect(out).not.toContain('<img');
    expect(out).toContain('radio-art-empty');
  });
});

describe('RadioSettings', () => {
  test('asks for email and password when nothing is connected, with the code as the other door', () => {
    const out = html(RadioSettings({ session: null, pending: null }));
    expect(out).toContain('action="/api/radio/connect/password"');
    expect(out).toContain('name="email"');
    expect(out).toContain('type="password"');
    expect(out).toContain('autocomplete="current-password"');
    expect(out).toContain('formaction="/api/radio/connect"');
    expect(out).not.toContain('name="otp"');
  });
  test('asks for the code while one is pending', () => {
    const out = html(RadioSettings({ session: null, pending: { email: 'a@b.c' } }));
    expect(out).toContain('action="/api/radio/connect/verify"');
    expect(out).toContain('name="otp"');
    expect(out).toContain('autocomplete="one-time-code"');
    expect(out).toContain('a@b.c');
    expect(out).toContain('formaction="/api/radio/connect/cancel"');
  });
  test('offers to disconnect once connected, and to reconnect when unreadable', () => {
    const on = html(RadioSettings({ session: { email: 'a@b.c' }, pending: null }));
    expect(on).toContain('action="/api/radio/disconnect"');
    expect(on).toContain('a@b.c');
    expect(on).not.toContain('name="email"');
    const broken = html(RadioSettings({ session: { unreadable: true }, pending: null }));
    expect(broken).toContain('no longer be decrypted');
    expect(broken).toContain('action="/api/radio/connect/password"');
  });
  test('shows what happened', () => {
    const out = html(
      RadioSettings({ session: null, pending: null, notice: 'Done.', error: 'Nope.' }),
    );
    expect(out).toContain('feedback ok');
    expect(out).toContain('feedback error');
  });
});

describe('RadioPage', () => {
  test('signed out: a pitch and a sign-in that comes back here', () => {
    const out = html(RadioPage({ user: null, session: null }));
    expect(out).toContain('href="/login?next=%2Fradio"');
    expect(out).not.toContain('data-radio-src');
  });
  test('signed in, not connected: points at settings', () => {
    const out = html(RadioPage({ user: { id: 'u' }, session: null }));
    expect(out).toContain('href="/settings#siriusxm"');
    expect(out).not.toContain('data-radio-src');
  });
  test('connected: tabs, search, quality and the rows, with the bundle attributes', () => {
    const out = html(
      RadioPage({ user: { id: 'u' }, session: { email: 'a@b.c' }, cat: 'news', channels: [ch] }),
    );
    expect(out).toMatch(/data-radio-src="\/vendor-player\.js(\?v=[^"]+)?"/);
    expect(out).toMatch(/data-radio-css="\/vendor-player\.css(\?v=[^"]+)?"/);
    expect(out).toContain('href="/radio?cat=news" class="active"');
    expect(out).toContain('name="q"');
    expect(out).toContain('data-radio-quality');
    expect(out).toContain('ESPN Radio');
  });
  test('an error from SiriusXM is shown, not swallowed', () => {
    const out = html(
      RadioPage({ user: { id: 'u' }, session: { email: 'a' }, channels: [], error: 'SXM said no' }),
    );
    expect(out).toContain('SXM said no');
  });
});

describe('RadioTeamSection', () => {
  test('names the lookup and fetches nothing at render', () => {
    const out = html(RadioTeamSection({ find: '/radio/find?event=42', sides: ['A', 'B'] }));
    expect(out).toContain('data-radio-find="/radio/find?event=42"');
    expect(out).toContain('data-radio-results');
    expect(out).toContain('Looking on SiriusXM');
    expect(out).toContain('Each side&#39;s own broadcast');
    const one = html(RadioTeamSection({ find: '/radio/find?team=7', sides: ['Denver Broncos'] }));
    expect(one).toContain('Denver Broncos&#39;s own broadcast');
  });
});

describe('RadioSidesFragment', () => {
  test('a side with a feed gets rows; without one, words; a failure, its reason', () => {
    const out = html(
      RadioSidesFragment({
        sides: [
          { team: 'Denver Broncos', stations: [ch] },
          { team: 'Kansas City Chiefs', stations: [] },
          { team: 'Nobody', stations: [], error: 'SXM said no' },
        ],
      }),
    );
    expect(out).toContain('ESPN Radio');
    expect(out).toContain('No Kansas City Chiefs feed on SiriusXM right now.');
    expect(out).toContain('SXM said no');
    expect(out).not.toContain('<!doctype');
  });
});

describe('Layout nav', () => {
  test('Radio is offered to a signed-in reader and to nobody else', () => {
    const on = html(Layout({ user: { id: 'u', timezone: 'UTC' }, children: 'x' }));
    expect(on).toContain('href="/radio"');
    const off = html(Layout({ user: null, children: 'x' }));
    expect(off).not.toContain('href="/radio"');
  });
});
