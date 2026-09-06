import { describe, expect, test } from 'bun:test';
import {
  datedElsewhere,
  feedLanguage,
  rankChannelsForFixture,
} from '../packages/sports/src/m3u.js';

/**
 * Why a Premier League fixture offered a Swedish recording from 2024.
 *
 * Reported as "our soccer games aren't matching m3u stream feeds but I know
 * they are there". They were there. The matcher found them and then ranked
 * them below two things that should never have been candidates at all:
 *
 *   1. An old broadcast. "(SE) ViaPlay 27 (D): 03-15-2024 7:55pm | Chelsea -
 *      Arsenal" names both teams EXACTLY, where a live channel is called
 *      "Arsenal" or "Premier Sports 1". A recording therefore always outranks
 *      the real thing -- it is a better match and a worse answer.
 *   2. The word "English". "English Premier League" put `english` among the
 *      words marking a channel as carrying the competition, so "Al Jazeera
 *      English" and "France 24 English" were offered for an Arsenal fixture.
 *
 * Measured against the real fixture (Chelsea at Arsenal, 2026-09-06) and the
 * real titles on a real line.
 */

const NOW = new Date('2026-09-06T15:00:00Z');

const fixture = (over = {}) => ({
  home: 'Arsenal',
  away: 'Chelsea',
  eventName: 'Chelsea at Arsenal',
  leagueName: 'English Premier League',
  leagueAbbr: 'EPL',
  sport: 'soccer',
  foreignMarkers: [],
  languages: ['en'],
  now: NOW,
  ...over,
});

const rank = (titles, over) =>
  rankChannelsForFixture(
    titles.map((t, i) => ({ id: i + 1, title: t, url: `http://line.test/${i}` })),
    fixture(over),
  );

const offered = (r) => [...r.certain, ...r.likely, ...r.competition].map((c) => c.title);

describe('a recording is not tonight', () => {
  test('a year that is not this year is always a recording', () => {
    expect(datedElsewhere('(SE) ViaPlay 27 (D): 03-15-2024 7:55pm | Chelsea - Arsenal', NOW)).toBe(
      true,
    );
    expect(datedElsewhere('D+ (UK) Events 98: Classic Premier League | 2008/09', NOW)).toBe(true);
  });

  test('a live channel carries no date and is kept', () => {
    expect(datedElsewhere('Arsenal - EPL - Premier League', NOW)).toBe(false);
    expect(datedElsewhere('Premier Sports 1 UK FHD', NOW)).toBe(false);
    // A bare channel number is not a date.
    expect(datedElsewhere('SPORTS: ESPN 2', NOW)).toBe(false);
  });

  test("a provider labelling tonight's game with tonight's date is telling the truth", () => {
    expect(datedElsewhere('Sky: 09-06-2026 3:30pm | Chelsea - Arsenal', NOW)).toBe(false);
    // The same day in a different order still reads as today.
    expect(datedElsewhere('Sky: 06/09/2026 | Chelsea - Arsenal', NOW)).toBe(false);
  });

  test('it never reaches the reader, however well it matches', () => {
    const r = rank([
      '(SE) ViaPlay 27 (D): 03-15-2024 7:55pm | Chelsea - Arsenal',
      'Arsenal - EPL - Premier League',
    ]);
    // It named BOTH teams and was the only thing offered before this.
    expect(offered(r)).not.toContain('(SE) ViaPlay 27 (D): 03-15-2024 7:55pm | Chelsea - Arsenal');
    expect(offered(r)).toContain('Arsenal - EPL - Premier League');
  });
});

describe('the language a feed is in', () => {
  test('is read from the provider tag, and only from there', () => {
    expect(feedLanguage('(SE) ViaPlay 27 (D): x')).toBe('se');
    expect(feedLanguage('(NL) ViaPlay 13 (D): x')).toBe('nl');
    expect(feedLanguage('(PL) ViaPlay 36 (D): x')).toBe('pl');
  });

  test('treats the English-speaking markets as one language', () => {
    for (const tag of ['UK', 'US', 'USA', 'IE', 'AU', 'NZ', 'CA']) {
      expect(feedLanguage(`(${tag}) Some Channel`)).toBe('en');
    }
  });

  test('says nothing about an untagged entry', () => {
    // Most of a list is untagged. Guessing here would empty the page.
    expect(feedLanguage('Arsenal - EPL - Premier League')).toBeNull();
    expect(feedLanguage('Premier Sports 1 UK FHD')).toBeNull();
  });

  test('an untagged entry is never filtered out', () => {
    const r = rank(['Arsenal - EPL - Premier League'], { languages: ['fr'] });
    expect(offered(r)).toContain('Arsenal - EPL - Premier League');
  });

  test('a tagged foreign feed is dropped for an English reader', () => {
    const r = rank(['(NL) ViaPlay 13: Arsenal - Chelsea', 'Arsenal - EPL - Premier League']);
    expect(offered(r)).not.toContain('(NL) ViaPlay 13: Arsenal - Chelsea');
  });

  test('and kept for a reader who asked for it', () => {
    const r = rank(['(NL) ViaPlay 13: Arsenal - Chelsea'], { languages: ['en', 'nl'] });
    expect(offered(r)).toContain('(NL) ViaPlay 13: Arsenal - Chelsea');
  });

  test('an empty preference switches the filter off entirely', () => {
    const r = rank(['(NL) ViaPlay 13: Arsenal - Chelsea'], { languages: [] });
    expect(offered(r)).toContain('(NL) ViaPlay 13: Arsenal - Chelsea');
  });
});

describe("a league's nationality is not evidence about a channel", () => {
  test('two news channels no longer carry the Premier League', () => {
    const r = rank([
      'USA: Al Jazeera English',
      'USA: France 24 English',
      'SPORTS: Gol TV English',
      'PC: Premier League TV',
    ]);
    const out = offered(r);
    expect(out).not.toContain('USA: Al Jazeera English');
    expect(out).not.toContain('USA: France 24 English');
    expect(out).toContain('PC: Premier League TV');
  });

  test('the competition itself still matches on its real name', () => {
    const r = rank(['PC: Premier League TV', 'Arsenal - EPL - Premier League']);
    expect(offered(r)).toEqual(
      expect.arrayContaining(['PC: Premier League TV', 'Arsenal - EPL - Premier League']),
    );
  });
});

describe('the fixture that was reported', () => {
  // Verbatim from the line, in the order the list holds them.
  const REAL = [
    '(SE) ViaPlay 27 (D): 03-15-2024 7:55pm | Chelsea - Arsenal',
    '(NL) ViaPlay 13 (D): 04-28-2024 1:25pm | Everton - Arsenal',
    '(PL) ViaPlay 38 (D): 04-14-2024 7:40pm | Arsenal - Bristol City',
    'D+ (UK) Events 98: Classic Premier League | Manchester City _ Liverpool | 2008/09',
    'USA: Al Jazeera English',
    'USA: France 24 English',
    'Arsenal - EPL - Premier League',
    'Chelsea - EPL - Premier League',
    'PC: Premier League TV',
  ];

  test('offers the clubs and the competition, and none of the noise', () => {
    const out = offered(rank(REAL));
    expect(out).toContain('Arsenal - EPL - Premier League');
    expect(out).toContain('Chelsea - EPL - Premier League');
    expect(out).toContain('PC: Premier League TV');
    for (const junk of REAL.filter((t) => !out.includes(t))) {
      // Everything dropped is either a recording or a foreign tag or a news
      // channel that merely contains the word "English".
      expect(
        datedElsewhere(junk, NOW) || feedLanguage(junk) !== null || junk.includes('English'),
      ).toBe(true);
    }
  });

  test('the two-year-old Swedish recording is not what a reader sees first', () => {
    const out = offered(rank(REAL));
    expect(out[0]).not.toContain('2024');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('the setting', () => {
  test('defaults to English and is a comma list', async () => {
    const { config } = await import('../packages/config/src/index.js');
    expect(config.playlists.languages).toEqual(['en']);
    const src = await Bun.file(
      new URL('../packages/config/src/index.js', import.meta.url).pathname,
    ).text();
    expect(src).toContain("opt('PLAYLIST_LANGUAGES', 'en')");
  });

  test('reaches the matcher from the playlist layer', async () => {
    const src = await Bun.file(
      new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
    ).text();
    expect(src).toContain('languages: config.playlists.languages');
  });
});
