import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { channelMatchesName, marketsWithOwnChannels } from '../packages/sports/src/m3u.js';

/**
 * Making the per-country broadcaster listings playable.
 *
 * ESPN and TheSportsDB say WHO carries a fixture in each country -- "Sky Sports
 * Main Event", "TNT Sports 1", "7 Queensland" -- and that was rendered as text
 * and nothing else. A reader whose own list held the exact channel being named
 * still had to go and find it themselves.
 */

const OWN = [
  { id: 1, title: 'Sky Sports Main Event HD', url: 'u1' },
  { id: 2, title: 'Sky Sports Football', url: 'u2' },
  { id: 3, title: 'TNT Sports 1 UHD', url: 'u3' },
  { id: 4, title: 'TNT Sports 2', url: 'u4' },
  { id: 5, title: '7 Queensland', url: 'u5' },
  { id: 6, title: 'NFL 03:', url: 'u6' },
];

describe('matching a broadcaster to a channel on your line', () => {
  test('an exact name matches, quality tags and all', () => {
    expect(channelMatchesName('Sky Sports Main Event HD', 'Sky Sports Main Event')).toBe(true);
    expect(channelMatchesName('TNT Sports 1 UHD', 'TNT Sports 1')).toBe(true);
  });

  /*
   * The regression this function was rewritten for.
   *
   * The first version reused the STOP list built for TEAM names, which discards
   * "sport", "event", "main" and "network". "Sky Sports Main Event" reduced to
   * "sky", so a game listed on Main Event offered Sky Sports Football, Sky Sports
   * Cricket and every other Sky channel in the list.
   */
  test('a sibling channel of the same broadcaster does not match', () => {
    expect(channelMatchesName('Sky Sports Football', 'Sky Sports Main Event')).toBe(false);
    expect(channelMatchesName('Sky Sports Cricket', 'Sky Sports Main Event')).toBe(false);
  });

  test('a different number is a different channel', () => {
    expect(channelMatchesName('TNT Sports 2', 'TNT Sports 1')).toBe(false);
  });

  /* A parked slot wins a shortest-title tiebreak and is dead air. */
  test('a placeholder slot is never offered', () => {
    expect(channelMatchesName('NFL 03:', 'NFL')).toBe(false);
  });

  test('a short name has to be the whole title', () => {
    expect(channelMatchesName('TNT', 'TNT')).toBe(true);
    expect(channelMatchesName('TNT Sports 1', 'TNT')).toBe(false);
  });
});

describe('pairing a market with a line', () => {
  const markets = [
    { country: 'United Kingdom', channels: ['Sky Sports Main Event', 'BBC One'] },
    { country: 'Australia', channels: ['7 Queensland'] },
  ];
  const paired = marketsWithOwnChannels(markets, OWN);

  test('keeps every country and every listing, matched or not', () => {
    expect(paired.map((m) => m.country)).toEqual(['United Kingdom', 'Australia']);
    expect(paired[0].channels.map((c) => c.name)).toEqual(['Sky Sports Main Event', 'BBC One']);
  });

  /*
   * A listing we cannot offer keeps its name. It is still true that the game is
   * on BBC One; filtering it out would turn a complete market into a partial one
   * and hide that the fixture is carried there at all.
   */
  test('an unmatched listing keeps its place with an empty list', () => {
    expect(paired[0].channels[1]).toEqual({ name: 'BBC One', own: [] });
  });

  test('a matched listing carries the reader’s own row', () => {
    expect(paired[0].channels[0].own.map((c) => c.id)).toEqual([1]);
    expect(paired[1].channels[0].own.map((c) => c.id)).toEqual([5]);
  });

  test('the plainest title ranks first', () => {
    const withAlt = marketsWithOwnChannels(
      [{ country: 'UK', channels: ['TNT Sports 1'] }],
      [
        { id: 9, title: 'TNT Sports 1 UHD BACKUP FEED', url: 'a' },
        { id: 8, title: 'TNT Sports 1', url: 'b' },
      ],
    );
    expect(withAlt[0].channels[0].own[0].id).toBe(8);
  });
});

describe('reaching one channel by its id', () => {
  let db;
  let ids = {};

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    const mk = async (email) =>
      (await db.query('insert into users (email) values ($1) returning id', [email])).rows[0].id;
    ids.mine = await mk('mine@example.com');
    ids.theirs = await mk('theirs@example.com');

    for (const [owner, title] of [
      [ids.mine, 'Sky Sports Main Event HD'],
      [ids.theirs, 'Sky Sports Main Event HD'],
    ]) {
      const pl = (
        await db.query(
          `insert into user_playlists (user_id, label, source_url) values ($1, 'l', 'sealed')
           returning id`,
          [owner],
        )
      ).rows[0].id;
      const ch = (
        await db.query(
          `insert into user_playlist_channels (playlist_id, position, title, stream_url, norm_title)
           values ($1, 0, $2, 'sealed', $3) returning id`,
          [pl, title, title.toLowerCase()],
        )
      ).rows[0].id;
      ids[owner === ids.mine ? 'myChannel' : 'theirChannel'] = ch;
    }
  }, 60_000);

  /** Mirrors ownChannelById. */
  const byId = async (userId, channelId) =>
    (
      await db.query(
        `select c.id from user_playlist_channels c
         join user_playlists p on p.id = c.playlist_id
         where p.user_id = $1 and c.id = $2`,
        [userId, channelId],
      )
    ).rows;

  test('returns the row when it is yours', async () => {
    expect(await byId(ids.mine, ids.myChannel)).toHaveLength(1);
  });

  /*
   * The reason these routes are keyed by id at all is that the ranked lists are
   * addressed by index, and an index means nothing in a listing arranged by
   * country. An id is a stable handle -- and a stable handle to somebody else's
   * row would be a much worse bug than a wrong index, so ownership is enforced by
   * the query rather than by each handler remembering to check.
   */
  test('returns nothing for somebody else’s channel', async () => {
    expect(await byId(ids.mine, ids.theirChannel)).toEqual([]);
  });
});

describe('what the page and the routes do with it', () => {
  const app = readFileSync(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');
  const view = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );

  test('every by-id route resolves through the ownership query', () => {
    for (const path of [
      '/my/channels/:channelId/check',
      '/my/channels/:channelId/playlist.m3u',
      '/my/channels/:channelId/stream.ts',
    ]) {
      const i = app.indexOf(`app.get('${path}'`);
      expect(i).toBeGreaterThan(-1);
      const body = app.slice(i, app.indexOf('\n});', i));
      expect(body).toContain('requireUser(c)');
      expect(body).toContain('ownChannelOr404(c, user)');
    }
  });

  test('the .m3u body is never cached', () => {
    const i = app.indexOf("app.get('/my/channels/:channelId/playlist.m3u'");
    expect(app.slice(i, app.indexOf('\n});', i))).toContain("'no-store, private'");
  });

  /*
   * The listing has to render identically for a reader with no list. It is the
   * same markets in the same order with buttons added where we can add them --
   * not a different section that appears for some people.
   */
  test('a reader with no matches still sees the plain listing', () => {
    expect(view).toContain('<p class="market-channels">{m.channels.join(\' · \')}</p>');
    expect(view).toContain('marketChannels ? assetUrl(');
  });

  test('the player is driven for every section on the page, not just the first', () => {
    const client = readFileSync(
      new URL('../apps/web/public/app.js', import.meta.url).pathname,
      'utf8',
    );
    expect(client).toContain("root.querySelectorAll('[data-player-src]')");
    // Chained rather than assigned: the second section would otherwise replace the
    // first's teardown, and a navigation would leave one player pulling a stream.
    expect(client).toContain('const previousStop = window.__tipoffStopPlayer;');
  });
});
