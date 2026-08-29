import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { EventPage } = await import('../apps/web/src/views/pages.jsx');
const { broadcastersFor } = await import('../packages/playlists/src/index.js');

/**
 * The last place still matching on the matchup alone.
 *
 * A shared list was read against the fixture and nothing else -- its teams, its
 * league, its own name -- so a national broadcast could never be found in one: no
 * NBC affiliate's title says "San José State". The owner's own page had learned to
 * ask the other question ("is this row the broadcaster the listing named?") when
 * the market picker did; a reader of somebody else's list had not, so a game on
 * NBC came back empty for everyone but the list's owner.
 */

describe('reading the broadcasters off an event', () => {
  test('takes them from the markets, jsonb or the string of it', () => {
    const markets = [
      { country: 'United States', channels: ['NBC', 'Peacock'] },
      { country: 'United Kingdom', channels: ['Sky Sports Main Event'] },
    ];
    expect(broadcastersFor({ broadcast_markets: markets })).toEqual([
      'NBC',
      'Peacock',
      'Sky Sports Main Event',
    ]);
    expect(broadcastersFor({ broadcast_markets: JSON.stringify(markets) })).toEqual([
      'NBC',
      'Peacock',
      'Sky Sports Main Event',
    ]);
  });

  /* Rows written before the markets column existed still carry the flat one. */
  test('falls back to the flat column, and to nothing at all', () => {
    expect(broadcastersFor({ broadcast: 'NBC, Peacock' })).toEqual(['NBC', 'Peacock']);
    expect(broadcastersFor({ broadcast_markets: 'not json', broadcast: 'NBC' })).toEqual(['NBC']);
    expect(broadcastersFor({})).toEqual([]);
    expect(broadcastersFor(null)).toEqual([]);
  });

  test('a market with no channels does not shadow the fallback', () => {
    expect(broadcastersFor({ broadcast_markets: [], broadcast: 'NBC' })).toEqual(['NBC']);
  });
});

const EVENT = {
  id: 127,
  name: 'San José State Spartans at USC Trojans',
  short_name: 'SJSU @ USC',
  state: 'pre',
  sport: 'football',
  league_name: 'NCAA - Football',
  starts_at: new Date('2026-09-05T23:30:00Z'),
  home_name: 'USC Trojans',
  away_name: 'San José State Spartans',
  home_team_id: 61,
  away_team_id: 62,
  broadcast: 'NBC',
  broadcast_country: 'United States',
  broadcast_markets: JSON.stringify([{ country: 'United States', channels: ['NBC'] }]),
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

/** A shared row as sharedChannelsForEvent returns it: an id, never a URL. */
const shared = (id, title) => ({
  id,
  title,
  group: null,
  ownerId: 'owner-1',
  ownerLabel: 'chovy',
  name: 'NBC',
});

describe('the network tier on a shared list', () => {
  test('renders and is playable, with no address anywhere on it', async () => {
    const out = await html({
      sharedChannels: {
        channelCount: 7059,
        owners: 1,
        channels: [],
        network: [shared(41, 'USA: NBC 4 LA (KNBC)'), shared(42, 'IL | Chicago | NBC (WMAQ)')],
      },
    });
    expect(out).toContain('Shared with you');
    expect(out).toContain('USA: NBC 4 LA (KNBC)');
    expect(out).toContain('IL | Chicago | NBC (WMAQ)');
    // Play goes through the proxy, which is the only way a shared row is watchable.
    expect(out).toContain('/shared/41/stream.ts');
    expect(out).toContain('/shared/42/check');
    // The claim is named honestly: the network, not "here is your game".
    expect(out).toContain('the network carrying it');
    expect(out).toContain('in United States');
  });

  /*
   * The section used to render only when a channel NAMED the fixture, so a
   * network-only match would have kept the "none of them name this fixture" miss
   * text with the answer sitting unrendered behind it.
   */
  test('a network-only match still opens the section', async () => {
    const out = await html({
      sharedChannels: {
        channelCount: 7059,
        owners: 1,
        channels: [],
        network: [shared(41, 'USA: NBC 4 LA (KNBC)')],
      },
    });
    expect(out).not.toContain('name this fixture.');
    expect(out).toContain('On NBC');
  });

  test('and reads as an addition when something did name the fixture', async () => {
    const out = await html({
      sharedChannels: {
        channelCount: 7059,
        owners: 1,
        channels: [
          {
            id: 9,
            title: 'SJSU vs USC',
            group: null,
            ownerId: 'owner-1',
            ownerLabel: 'chovy',
          },
        ],
        network: [shared(41, 'USA: NBC 4 LA (KNBC)')],
      },
    });
    expect(out).toContain('SJSU vs USC');
    expect(out).toContain('Also on NBC');
  });

  test('nothing either way is still the miss it always was', async () => {
    const out = await html({
      sharedChannels: { channelCount: 7059, owners: 0, channels: [], network: [] },
    });
    expect(out).toContain('name this fixture.');
    expect(out).not.toContain('the network carrying it');
  });
});
