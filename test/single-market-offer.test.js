import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { EventPage } = await import('../apps/web/src/views/pages.jsx');

/**
 * The offer a one-market fixture used to throw away.
 *
 * "Where to watch" rendered only for two markets or more, on the reasoning that
 * one country needs no tab strip. That was right about the strip and wrong about
 * everything else: one market is the shape of nearly every US fixture there is, so
 * a game listed on NBC showed a stat tile reading "NBC · Watch on TV · United
 * States" and stopped, while the reader's own line had NBC on it and no part of the
 * page said so. This is the report that produced this test.
 */

const EVENT = {
  id: 512,
  name: 'LSU Tigers at USC Trojans',
  short_name: 'LSU @ USC',
  state: 'pre',
  sport: 'football',
  league_slug: 'football-college-football',
  league_name: 'NCAA - Football',
  starts_at: new Date('2026-09-05T23:30:00Z'),
  venue: 'Los Angeles Memorial Coliseum',
  venue_city: 'Los Angeles',
  venue_region: 'CA',
  home_name: 'USC Trojans',
  away_name: 'LSU Tigers',
  home_team_id: 61,
  away_team_id: 62,
  broadcast: 'NBC',
  broadcast_country: 'United States',
  // Stored as jsonb and read back as a string on some paths, which marketsOf
  // handles either way -- the string is the harder case, so it is the one used.
  broadcast_markets: JSON.stringify([{ country: 'United States', channels: ['NBC'] }]),
};

/** What marketChannelsForEvent returns once a reader's own NBC row matched. */
const MINE = {
  matched: 1,
  markets: [
    {
      country: 'United States',
      channels: [{ name: 'NBC', own: [{ id: 88, title: 'USA| NBC HD', url: 'http://line/nbc' }] }],
    },
  ],
};

const html = async (props) =>
  (
    await EventPage({
      user: { id: 'u1' },
      event: EVENT,
      offers: [],
      entitlement: null,
      plays: [],
      ...props,
    }).toString()
  ).toString();

describe('one market, and the reader has that channel', () => {
  test('the section renders and the channel is offered', async () => {
    const out = await html({ marketChannels: MINE });
    expect(out).toContain('Where to watch');
    expect(out).toContain('This game is on NBC in United States.');
    expect(out).toContain('It is on your own line');
    // The row is their copy, named as theirs, with something to press.
    expect(out).toContain('USA| NBC HD');
    expect(out).toContain('/my/channels/88/playlist.m3u');
    expect(out).toContain('/my/channels/88/stream.ts');
  });

  test('it does not count to one country or offer a choice of one', async () => {
    const out = await html({ marketChannels: MINE });
    expect(out).not.toContain('carried in 1 countries');
    expect(out).not.toContain('Pick yours');
  });

  /*
   * The tile used to stand down here, on the reasoning that "NBC" twice on one
   * page was once too many. That read as the channel list having been removed from
   * the fixture's metadata and moved down into the stream list, and Anthony asked
   * for both: the tile names the channel with the other facts, the section below
   * is where it can be opened.
   */
  test('the stat tile stays alongside the section', async () => {
    const out = await html({ marketChannels: MINE });
    expect(out).toContain('Watch on TV · United States');
    expect(out).toContain('<h2>Where to watch</h2>');
  });
});

/*
 * The two sections answer different questions, and one of them used to contradict
 * the other. "On your line" asks whether a channel NAMES this fixture; "Where to
 * watch" asks whether the reader has the network carrying it. For a national game
 * on NBC the first fails and the second succeeds, which printed "your provider does
 * not have it, which is on NBC" directly beneath three NBC stations from that very
 * list.
 */
describe('the two sections do not contradict each other', () => {
  const noNameMatch = { hasList: true, channelCount: 7059, matches: [], competition: [] };

  test('a fixture nothing names still says the network is on the line', async () => {
    const out = await html({ marketChannels: MINE, ownChannels: noNameMatch });
    expect(out).toContain('None of your 7,059 channels name this fixture');
    expect(out).not.toContain('your provider does not have it');
    expect(out).toContain('is on your line');
  });

  test('and says the old thing when there is genuinely nothing', async () => {
    const out = await html({ marketChannels: null, ownChannels: noNameMatch });
    expect(out).toContain('your provider does not have it');
  });
});

describe('one market, and nothing of the reader’s matched', () => {
  test('the page is exactly what it always was', async () => {
    const out = await html({ marketChannels: null });
    expect(out).toContain('Watch on TV · United States');
    // The visible section. The listing is still published as structured data,
    // where its name carries these same words.
    expect(out).not.toContain('<h2>Where to watch</h2>');
  });
});

describe('more than one market is untouched', () => {
  const many = {
    ...EVENT,
    broadcast: 'NBC, Peacock',
    broadcast_markets: JSON.stringify([
      { country: 'United States', channels: ['NBC', 'Peacock'] },
      { country: 'United Kingdom', channels: ['Sky Sports Main Event'] },
    ]),
  };

  test('still counts its countries and still offers the picker', async () => {
    const out = await html({ event: many, marketChannels: null });
    expect(out).toContain('carried in 2 countries');
    expect(out).toContain('Pick yours');
    // The tile names the widest market and counts the rest, rather than claiming
    // a single answer the fixture does not have -- or vanishing, which is how a
    // multi-market game lost its channels from the metadata altogether.
    expect(out).toContain('Watch on TV · United States · 1 more country');
  });

  test('and still counts what is on the line when something matched', async () => {
    const out = await html({
      event: many,
      marketChannels: {
        matched: 2,
        markets: [
          {
            country: 'United States',
            channels: [
              { name: 'NBC', own: [{ id: 88, title: 'USA| NBC HD', url: 'http://line/nbc' }] },
              { name: 'Peacock', own: [] },
            ],
          },
          {
            country: 'United Kingdom',
            channels: [
              {
                name: 'Sky Sports Main Event',
                own: [{ id: 91, title: 'Sky Sports Main Event HD', url: 'http://line/sky' }],
              },
            ],
          },
        ],
      },
    });
    expect(out).toContain('2 of these are on your own line');
    expect(out).toContain('not on your list');
  });
});
