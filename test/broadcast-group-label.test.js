import { describe, expect, test } from 'bun:test';
import { GUESSED, SPELLED } from '../packages/sports/src/broadcasters.js';
import {
  broadcastTerms,
  LITERAL,
  marketsWithOwnChannels,
  nameMatchRank,
} from '../packages/sports/src/m3u.js';

/**
 * The shelf a provider files a channel under is not part of the channel's name.
 *
 * Reported against a football game listed on USA: the reader's list carries the
 * network as plain "USA", and the page offered MLB Network, NFL Network and CBS
 * Sports Network instead -- every row that happened to have the word "network" in
 * its name and the word "USA" on its shelf.
 *
 * Two words, taken from two different places, were being counted as the broadcaster
 * having been named outright. Because marketsWithOwnChannels keeps only the surest
 * reading, those false literals then evicted the one row that was actually right.
 *
 * Nothing here is about USA. Any broadcaster sharing a word with a group label --
 * a country, a region, a city, a genre -- had the same hole.
 */

describe('a group label cannot supply half the name', () => {
  test('the row that is actually the network wins', () => {
    // The shape reported: no row in this list says "USA Network".
    const list = [
      'USA| CBS SPORTS NETWORK HD',
      'USA| NFL NETWORK HD',
      'USA| MLB NETWORK',
      'USA| NBA TV NETWORK',
      'USA| USA HD',
      'USA| ESPN HD',
    ].map((title, id) => ({ id, title, url: `u${id}` }));

    const [market] = marketsWithOwnChannels(
      [{ country: 'United States', channels: ['USA Network'] }],
      list,
    );
    expect(market.channels[0].own.map((c) => c.title)).toEqual(['USA| USA HD']);
  });

  test('and the same when the listing abbreviates it', () => {
    // ESPN writes "USA Net" in thirteen characters; TheSportsDB writes it out. Both
    // have to reach the same row.
    const list = ['USA| MLB NETWORK', 'USA| USA HD'].map((title, id) => ({
      id,
      title,
      url: `u${id}`,
    }));
    const [market] = marketsWithOwnChannels(
      [{ country: 'United States', channels: ['USA Net'] }],
      list,
    );
    expect(market.channels[0].own.map((c) => c.title)).toEqual(['USA| USA HD']);
  });

  test('a channel naming itself outranks one leaning on its shelf', () => {
    expect(nameMatchRank('USA| USA NETWORK HD', 'USA Network')).toBe(LITERAL);
    // Plain "USA" is the same channel with the furniture word left off.
    expect(nameMatchRank('USA| USA HD', 'USA Network')).toBe(SPELLED);
    // Its shelf says USA and its name says Network, and it is neither.
    expect(nameMatchRank('USA| MLB NETWORK', 'USA Network')).toBe(GUESSED);
    expect(nameMatchRank('USA| CBS SPORTS NETWORK HD', 'USA Network')).toBe(GUESSED);
  });

  test('but a label telling the truth is still worth offering', () => {
    // "BOSTON| NBC SPORTS" is NBC Sports Boston written across the separator rather
    // than after it. Demoted, never refused -- a reader with only this row still
    // gets it.
    expect(nameMatchRank('BOSTON| NBC SPORTS HD', 'NBC Sports Boston')).toBe(GUESSED);
    expect(nameMatchRank('SKY SPORTS | MAIN EVENT', 'Sky Sports Main Event')).toBe(GUESSED);
  });

  test('the same hole, other broadcasters', () => {
    // A furniture word the shelf also uses is the general case; "USA" was one instance.
    expect(nameMatchRank('SPORTS| NBA TV', 'NFL Network')).toBe(0);
    expect(nameMatchRank('USA| GOLF CHANNEL HD', 'Golf Channel')).toBe(LITERAL);
    expect(nameMatchRank('USA| GOLF HD', 'Golf Channel')).toBe(SPELLED);
  });

  test('and nothing that named the channel before stops matching', () => {
    expect(nameMatchRank('USA| CBS SPORTS NETWORK', 'CBS Sports Network')).toBe(LITERAL);
    expect(nameMatchRank('CANADA| TSN 1 HD', 'TSN')).toBe(LITERAL);
    expect(nameMatchRank('USA| CBS (WGCL) ATLANTA', 'CBS')).toBe(LITERAL);
    expect(nameMatchRank('USA| ESPN HD', 'USA Network')).toBe(0);
  });
});

/**
 * A broadcaster made only of the words matchTerms throws away.
 *
 * The candidate query is asked for terms and returns nothing at all when handed
 * none, so these names could never be offered even to a reader whose list carried
 * the exact channel -- the row was never fetched to be ranked.
 */
describe('a broadcaster with no distinctive word', () => {
  test('still asks the database for something', () => {
    for (const name of ['Match TV', 'Sport TV', 'Sport 1', 'The Sports Network', 'Main Event']) {
      expect(broadcastTerms(name).length).toBeGreaterThan(0);
    }
    expect(broadcastTerms('Match TV')).toContain('match');
    expect(broadcastTerms('Sport TV')).toContain('sport');
  });

  test('and a name with one keeps using it, because it is the selective one', () => {
    // Unchanged behaviour: the fallback is a floor, not a replacement.
    expect(broadcastTerms('USA Network')).toEqual(['usa']);
    expect(broadcastTerms('MLB Network')).toEqual(['mlb']);
  });
});
