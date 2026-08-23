import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * Checking a channel before offering it.
 *
 * A provider playlist is mostly aspirational: the slot exists, the title matches
 * the fixture, and a large share of them answer with an HTML error page instead
 * of video. The page listed every title that matched and let the reader find out
 * by pressing Play, so "Your provider did not send a stream for that channel" was
 * a routine outcome of using the feature exactly as intended. The .m3u route has
 * probed since it was written; the page had no way to.
 *
 * These assertions are on the RENDERED row rather than on the source that
 * produces it -- the two channel lists were near-identical and are now one
 * component, and a test that reads the source has to be rewritten every time that
 * changes, whether or not the guarantee did.
 */
const { ChannelRow } = await import('../apps/web/src/views/pages.jsx');

const event = { id: 428, league_name: 'MLS' };
const render = (props) => ChannelRow(props).toString();

describe('the row a reader is offered', () => {
  test('carries the check route, not the stream', () => {
    // The credential belongs in the VLC href, where an external app that holds no
    // session with us needs it -- and nowhere else. A URL in a data attribute
    // would additionally sit in the DOM for any extension to read.
    const html = render({ event, ch: { title: 'Sky Sports', url: 'http://line/1' }, index: 2 });
    expect(html).toContain('data-check="/events/428/channel-check?n=2"');
    expect(html).not.toContain('data-check="http://line/1"');
  });

  test('a competition channel checks its own list', () => {
    // Series channels are a different list on the server, indexed separately. A
    // check that dropped the distinction would verify the wrong channel and
    // remove a working one.
    const html = render({
      event,
      ch: { title: 'F1 TV', url: 'http://line/9' },
      index: 0,
      series: true,
    });
    expect(html).toContain('data-check="/events/428/channel-check?series=0"');
  });

  test('nothing has vouched for it yet, so it says so in the markup', () => {
    const html = render({ event, ch: { title: 'X', url: 'http://line/1' }, index: 0 });
    // The empty slot the verdict lands in, and no claim of verification.
    expect(html).toContain('own-channel-state');
    expect(html).not.toContain('data-verified');
  });

  test('a verdict the server already holds is carried, so the page does not re-probe', () => {
    // These lines cap concurrent connections. Opening a page twice must not cost
    // two probes of the same slot.
    const html = render({
      event,
      ch: { title: 'X', url: 'http://line/1', verified: true },
      index: 0,
    });
    expect(html).toContain('data-verified="1"');
  });

  test('the app hand-offs are still there, on both kinds of row', () => {
    // The whole point of Play being an addition: iPhone Safari cannot use it, and
    // VLC there is not a fallback but the primary route.
    const fixture = render({ event, ch: { title: 'X', url: 'http://line/1' }, index: 3 });
    expect(fixture).toContain('vlc-x-callback://x-callback-url/stream?url=');
    expect(fixture).toContain('infuse://x-callback-url/play?url=');
    expect(fixture).toContain('/events/428/playlist.m3u?n=3');

    const series = render({
      event,
      ch: { title: 'X', url: 'http://line/1' },
      index: 1,
      series: true,
    });
    expect(series).toContain('/events/428/playlist.m3u?series=1');
    expect(series).toContain('vlc-x-callback://');
  });

  test('Play ships disabled on both kinds of row', () => {
    // Two separate reasons now: this browser may have no Media Source Extensions,
    // and nothing has established the provider is actually sending this channel.
    for (const series of [false, true]) {
      const html = render({ event, ch: { title: 'X', url: 'http://line/1' }, index: 0, series });
      expect(html).toContain('disabled');
      expect(html).toContain('/events/428/stream.ts?');
    }
    expect(render({ event, ch: { title: 'X', url: 'u' }, index: 0, series: true })).toContain(
      'stream.ts?series=0',
    );
  });
});

describe('how the sweep behaves', () => {
  const client = readFileSync(
    new URL('../apps/web/public/app.js', import.meta.url).pathname,
    'utf8',
  );
  const app = readFileSync(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');

  test('one channel at a time, never the whole list at once', () => {
    // These are one subscriber's own connections on a line that usually permits
    // exactly one. Five checks at once is how an account gets flagged.
    expect(client).toContain('for (const li of pending) {');
    expect(client).not.toMatch(/Promise\.all\([^)]*dataset\.check/);
  });

  test('the server refuses to probe while something is playing', () => {
    // A probe is a connection like any other, and a new claim now evicts the old
    // -- so a background check would take the reader's own match off them.
    expect(app).toContain('if (streamSlotsOpen(user.id) > 0) return c.json({ skipped:');
  });

  test('pressing Play abandons the sweep, and stopping resumes it', () => {
    // Without the restart, a reader who presses Play mid-sweep leaves every
    // unchecked row disabled for the life of the page.
    expect(client).toContain('sweep.abort();');
    expect(client).toContain('startSweep();');
  });

  test('an abort is not a verdict', () => {
    // The row is unchecked, not confirmed: it must not be enabled on the strength
    // of a check that never finished.
    expect(client).toContain('if (signal?.aborted) {');
  });

  test('a dead channel is removed rather than greyed out', () => {
    // Greying one out leaves the reader deciding whether to try it anyway, and
    // the answer is no.
    expect(client).toContain('li.remove();');
  });

  test('the verdict is written back for the next reader', () => {
    // The 30-minute filter in playlistChannels, the .m3u route and the next page
    // view all inherit what one check learned.
    const checkRoute = app.slice(app.indexOf("app.get('/events/:id/channel-check'"));
    expect(checkRoute.slice(0, 2000)).toContain('markChannelChecked');
  });
});
