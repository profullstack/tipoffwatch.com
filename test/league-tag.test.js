import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * The competition tag on a fixture row.
 *
 * On a page mixing 354 competitions, "is this MLB or is this college baseball" is
 * the first question a row has to answer, and it used to be answered third in a
 * run of muted metadata after the venue -- which is where the eye stops reading.
 */

const components = readFileSync(
  new URL('../apps/web/src/views/components.jsx', import.meta.url).pathname,
  'utf8',
);
const queries = readFileSync(
  new URL('../packages/db/src/queries.js', import.meta.url).pathname,
  'utf8',
);

describe('what the tag says', () => {
  test('the abbreviation where there is one, the full name otherwise', () => {
    expect(components).toContain('const short = event.league_abbr?.trim()');
    expect(components).toContain('const full = event.league_name?.trim()');
    expect(components).toContain('const label = short || full');
  });

  /* A chip reading "NCAAB" has to stay identifiable to somebody who does not
     already know it, and the row has no room to spell it out. */
  test('the unabbreviated name is carried in the title attribute', () => {
    expect(components).toContain('title={full && full !== label ? full : undefined}');
  });

  test('a row with neither renders nothing rather than an empty chip', () => {
    expect(components).toContain('if (!short && !full) return null');
  });

  /*
   * Linked per row rather than per list. Not every list query carries the slug,
   * and a chip that navigates on some rows and not others is worse than one that
   * never does.
   */
  test('it links only where the slug came back with the row', () => {
    expect(components).toContain('event.league_slug ?');
  });
});

describe('where the abbreviation comes from', () => {
  /*
   * The tag is rendered by EventRow, which every list on the site uses. A query
   * that carries league_name but not league_abbr therefore renders the long name
   * where every other list shows the short one -- visible, inconsistent, and
   * exactly the kind of thing nobody notices in review.
   */
  test('every query that carries the league name carries its abbreviation', () => {
    const withName = queries.match(/l\.name as league_name/g)?.length ?? 0;
    const withAbbr = queries.match(/l\.abbreviation as league_abbr/g)?.length ?? 0;
    expect(withName).toBeGreaterThan(10);
    // getEvent already had the abbreviation on its own line before this, so the
    // two counts are equal rather than the abbreviation trailing.
    expect(withAbbr).toBe(withName);
  });
});

describe('the tag on a channel row', () => {
  const pages = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );

  /*
   * The provider's own words, not ours. A reader looking at ten near-identical
   * rows needs the string their own player shows them; our guess at what it means
   * would be a confident wrong mapping, which is worse than the raw text.
   */
  test('shows the provider group verbatim', () => {
    expect(pages).toContain('<span class="league-tag channel-tag">{ch.group}</span>');
  });

  test('and says outright when an entry is a file rather than a channel', () => {
    expect(pages).toContain("ch.kind !== 'live'");
    expect(pages).toContain('On demand');
  });
});
