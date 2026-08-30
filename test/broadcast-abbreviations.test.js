import { describe, expect, test } from 'bun:test';
import {
  canonicalBroadcaster,
  initialismOf,
  shortensTo,
  spellsOut,
} from '../packages/sports/src/broadcasters.js';
import { channelMatchesName, marketsWithOwnChannels } from '../packages/sports/src/m3u.js';

/**
 * Reading the abbreviated broadcaster names ESPN actually publishes.
 *
 * Reported against tipoffwatch.com/events/302 -- Orioles at Athletics -- which read
 * "MLB.TV, MASN, NBC Sports CA" and offered nothing, because a reader's list calls
 * those MLB Network and NBC Sports California. Neither shares a full word with what
 * ESPN wrote, and every word had to be present.
 *
 * The names below are not invented: they were measured from ESPN's scoreboard across
 * MLB, NBA, NFL, NHL, WNBA, college football, college basketball and MLS on seven
 * dates -- 83 distinct broadcasters, of which these are the ones no whole-word match
 * could ever reach. The channel titles are in the shapes the 7,059-entry list behind
 * the market picker uses.
 */

describe('a name cut short', () => {
  test('finds the channel that spells it out', () => {
    expect(channelMatchesName('USA: NBC Sports California', 'NBC Sports CA')).toBe(true);
    expect(channelMatchesName('CA | Sacramento | NBC Sports California HD', 'NBC Sports CA')).toBe(
      true,
    );
    expect(channelMatchesName('USA| NBC SPORTS BOSTON', 'NBC Sports BO')).toBe(true);
    expect(channelMatchesName('USA: NBC Sports Philadelphia HD', 'NBC Sports Phil')).toBe(true);
    expect(channelMatchesName('USA| USA NETWORK HD', 'USA Net')).toBe(true);
    expect(channelMatchesName('US: ESPN Unlimited', 'ESPN Unlmtd')).toBe(true);
    expect(channelMatchesName('USA| MARQUEE SPORTS NETWORK', 'Marquee Sports Net')).toBe(true);
  });

  test('reads a short form over more than one word', () => {
    // "BA" is Bay Area, so the last word of the listing stands for two of the channel's.
    expect(channelMatchesName('USA: NBC Sports Bay Area', 'NBC Sports BA')).toBe(true);
  });

  test('will not guess at the city', () => {
    // Both stations existed. "CA" begins California and does not begin Chicago, and
    // that is the whole of what tells them apart.
    expect(channelMatchesName('USA: NBC Sports Chicago', 'NBC Sports CA')).toBe(false);
    expect(channelMatchesName('USA| NBC SPORTS BAY AREA', 'NBC Sports BO')).toBe(false);
  });
});

describe('a "TV" and a "Network" are the same claim', () => {
  test('MLB.TV finds MLB Network, which is the shape that was reported', () => {
    expect(channelMatchesName('USA| MLB NETWORK HD', 'MLB.TV')).toBe(true);
  });

  test('and every team feed spelled the same way', () => {
    // Rockies.TV, Tigers.TV, Twins.TV, Reds.TV and a dozen more are in one night's
    // listings; the dot is what a provider writes as a space.
    expect(channelMatchesName('USA| ROCKIES TV', 'Rockies.TV')).toBe(true);
    expect(channelMatchesName('USA: Tigers Network', 'Tigers.TV')).toBe(true);
  });

  test('but what is left has to match exactly', () => {
    // MLB Extra Innings is a package of games, not the channel the listing named.
    expect(channelMatchesName('USA| MLB EXTRA INNINGS', 'MLB.TV')).toBe(false);
    expect(channelMatchesName('USA: MLB Network', 'NBA TV')).toBe(false);
    // "USA Net" is USA Network. It is not the first channel filed under "USA|" whose
    // name happens to start with those letters.
    expect(channelMatchesName('USA| NETFLIX HD', 'USA Net')).toBe(false);
  });
});

describe('one word standing for several', () => {
  test('finds the name behind the initials', () => {
    expect(channelMatchesName('USA| CHICAGO SPORTS NETWORK', 'CHSN')).toBe(true);
    expect(channelMatchesName('USA: SportsNet New York', 'SNY')).toBe(true);
    expect(channelMatchesName('USA| BIG TEN NETWORK', 'BTN')).toBe(true);
    expect(channelMatchesName('USA: CBS Sports Network', 'CBSSN')).toBe(true);
    expect(channelMatchesName('USA| FOX SPORTS 1 HD', 'FS1')).toBe(true);
    expect(channelMatchesName('USA: Mid-Atlantic Sports Network', 'MASN')).toBe(true);
    expect(channelMatchesName('USA| NEW ENGLAND SPORTS NETWORK', 'NESN')).toBe(true);
  });

  test('every run has to begin its word', () => {
    // The guard that keeps a network off its own sub-brands: "bc" does not begin
    // "sports", so NBC cannot be read as an initialism of NBC Sports.
    expect(initialismOf('nbc', ['nbc', 'sports'])).toBe(false);
    expect(initialismOf('chsn', ['chicago', 'sports', 'network'])).toBe(true);
  });

  test('and a channel is never an initialism of its own first word', () => {
    // Without this, "CBS" reads CBS Sports Network as "cb" + "s" and offers the
    // wrong channel to somebody expecting the network.
    expect(channelMatchesName('USA: CBS Sports Network', 'CBS')).toBe(false);
    expect(channelMatchesName('USA| NBC SPORTS WASHINGTON', 'NBC')).toBe(false);
    expect(channelMatchesName('USA| FOX SPORTS 1', 'FOX')).toBe(false);
  });

  test('two letters over two words is not a claim worth making', () => {
    expect(channelMatchesName('USA| CW SEATTLE', 'MW')).toBe(false);
  });
});

describe('a digit standing in for a letter', () => {
  test('does not stop a list being read', () => {
    // The Big Ten brands itself B1G and provider lists follow it.
    expect(channelMatchesName('USA| B1G TEN NETWORK', 'BTN')).toBe(true);
    expect(channelMatchesName('USA| B1G TEN NETWORK', 'Big Ten Network')).toBe(true);
    expect(channelMatchesName('USA| L1VE SPORTS 1', 'Live Sports 1')).toBe(true);
  });

  test('but a digit on the END is a channel number and means the opposite', () => {
    // Read "2" as "two" here and ESPN2 becomes a longer spelling of ESPN.
    expect(channelMatchesName('USA| ESPN2 HD', 'ESPN')).toBe(false);
    expect(channelMatchesName('USA| ESPNU', 'ESPN')).toBe(false);
  });

  test('and a streaming tier is still not the channel it is named after', () => {
    // B1G+ carries what the network does not, which is the point of it -- the same
    // relationship as NBC to NBC Sports, and refused for the same reason.
    expect(channelMatchesName('USA| BIG TEN NETWORK', 'B1G+')).toBe(false);
    expect(channelMatchesName('USA| B1G+ HD', 'B1G+')).toBe(true);
  });
});

describe('the refusals these rules must not undo', () => {
  test('a sibling feed is still a different channel', () => {
    expect(channelMatchesName('TNT Sports 2', 'TNT Sports 1')).toBe(false);
    expect(channelMatchesName('USA| FOX SPORTS 2', 'FS1')).toBe(false);
    // A whole name with a number after it is the second feed of it, not a longer
    // spelling of it.
    expect(channelMatchesName('USA| MASN2 HD', 'MASN')).toBe(false);
    expect(shortensTo('masn', 'masn2')).toBe(false);
  });

  test('and the rest of the pinned list', () => {
    expect(channelMatchesName('PC: NBC Sports', 'NBC')).toBe(false);
    expect(channelMatchesName('USA| CNBC HD', 'NBC')).toBe(false);
    expect(channelMatchesName('CBS Sports Golazo Network', 'CBS')).toBe(false);
    expect(channelMatchesName('Sky Sports Football', 'Sky Sports Main Event')).toBe(false);
    expect(channelMatchesName('NFL 03:', 'NFL')).toBe(false);
  });

  test('and what already matched still matches', () => {
    expect(channelMatchesName('USA| NBC HD', 'NBC')).toBe(true);
    expect(channelMatchesName('IL | Chicago | NBC (WMAQ)', 'NBC')).toBe(true);
    expect(channelMatchesName('Sky Sports Main Event HD', 'Sky Sports Main Event')).toBe(true);
    expect(channelMatchesName('TNT Sports 1 UHD', 'TNT Sports 1')).toBe(true);
  });
});

describe('shortensTo', () => {
  test('under four letters it has to be a prefix', () => {
    expect(shortensTo('ca', 'california')).toBe(true);
    expect(shortensTo('ca', 'chicago')).toBe(false);
    expect(shortensTo('net', 'network')).toBe(true);
  });

  test('above it the middle may drop out', () => {
    expect(shortensTo('unlmtd', 'unlimited')).toBe(true);
    expect(shortensTo('mnmt', 'monumental')).toBe(true);
  });

  test('the first letter never does', () => {
    expect(shortensTo('bc', 'nbc')).toBe(false);
  });
});

describe('the whole event, end to end', () => {
  test('the reported page now offers all three of its channels', () => {
    const own = [
      { id: 1, title: 'USA| MLB NETWORK HD', url: 'u1' },
      { id: 2, title: 'USA| MASN HD', url: 'u2' },
      { id: 3, title: 'USA: NBC Sports California', url: 'u3' },
      { id: 4, title: 'USA| MLB EXTRA INNINGS', url: 'u4' },
    ];
    const [market] = marketsWithOwnChannels(
      [{ country: 'United States', channels: ['MLB.TV', 'MASN', 'NBC Sports California'] }],
      own,
    );
    expect(market.channels.map((c) => c.own.map((o) => o.id))).toEqual([[1], [2], [3]]);
  });

  test('and initials that fit two channels offer only the one they were meant for', () => {
    // MASN is Mid-Atlantic Sports Network. It is also, letter for letter, a way to
    // cut up Marquee Sports Network -- which carries the Cubs, and would have been
    // put in front of an Orioles fan on a shortest-title tiebreak.
    const [market] = marketsWithOwnChannels(
      [{ country: 'United States', channels: ['MASN'] }],
      [
        { id: 1, title: 'USA| MARQUEE SPORTS NETWORK', url: 'u1' },
        { id: 2, title: 'USA| MID-ATLANTIC SPORTS NETWORK', url: 'u2' },
      ],
    );
    expect(market.channels[0].own.map((o) => o.id)).toEqual([2]);
  });
});

describe('what the page calls it', () => {
  test('a name ESPN cut off is spelled out', () => {
    expect(canonicalBroadcaster('NBC Sports CA')).toBe('NBC Sports California');
    expect(canonicalBroadcaster('USA Net')).toBe('USA Network');
    expect(canonicalBroadcaster('ESPN Unlmtd')).toBe('ESPN Unlimited');
  });

  test('a name it did not is left exactly as it came', () => {
    // MLB.TV is the streaming product and MLB Network is the cable channel. A
    // reader's MLB Network is offered for it, which is not the same as claiming the
    // game is on it.
    expect(canonicalBroadcaster('MLB.TV')).toBe('MLB.TV');
    expect(canonicalBroadcaster('MASN')).toBe('MASN');
    expect(canonicalBroadcaster('Sky Sports Main Event')).toBe('Sky Sports Main Event');
  });

  test('and the spelling out does not carry the matching', () => {
    // Nothing above depends on the map: the rules find the channel either way, which
    // is why an abbreviation nobody has written down still works.
    expect(spellsOut('NBC Sports WSH', 'NBC Sports Washington')).toBeGreaterThan(0);
    expect(spellsOut('NBC Sports SEA', 'NBC Sports Seattle')).toBeGreaterThan(0);
  });
});
