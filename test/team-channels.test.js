import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A participant's own page, and the reader's own line.
 *
 * The sibling brand had this gap reported against it first: a page somebody
 * reaches by searching for something they want to watch listed fixtures and never
 * once consulted their own subscription. Same code, same gap, same fix -- and here
 * the useful answer is usually the competition tier, because a 24/7 club or league
 * channel carries whatever that club is doing whether or not anything is on today.
 */

const app = readFileSync(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');
const pages = readFileSync(
  new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
  'utf8',
);
const playlists = readFileSync(
  new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
  'utf8',
);

describe('a team page asks the question', () => {
  test('the route consults the reader’s own list', () => {
    const route = app.slice(app.indexOf('`/${brand.paths.participant}/:slug`'));
    expect(route.slice(0, route.indexOf('\n});'))).toContain('ownChannelsForTeam');
  });

  test('and the page renders it', () => {
    const view = pages.slice(pages.indexOf('export const TeamPage'));
    const body = view.slice(0, view.indexOf('\n);\n'));
    expect(body).toContain('ownChannels?.hasList');
    expect(body).toContain('<ChannelRow ch={ch} />');
  });

  /*
   * One side, not two. rankChannelsForFixture has a branch for a thing with no
   * opponent -- built for races and fight cards -- and a team page is exactly that
   * shape: a name, a competition, and no second party.
   */
  test('it matches on the one name, with no opponent', () => {
    const fn = playlists.slice(playlists.indexOf('export async function ownChannelsForTeam'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('home: null');
    expect(body).toContain('away: null');
    expect(body).toContain('eventName: team.display_name');
    // The competition is what makes a team with nothing on today still useful.
    expect(body).toContain('leagueName: team.league_name');
  });

  test('both callers share one matcher rather than duplicating the ranking', () => {
    expect(playlists).toContain('export async function ownChannelsFor(');
    for (const wrapper of ['ownChannelsForEvent', 'ownChannelsForTeam']) {
      const fn = playlists.slice(playlists.indexOf(`export async function ${wrapper}`));
      expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('return ownChannelsFor(');
    }
  });

  /* Rendered only when there is something to show: a heading over an empty list
     on every team page in the catalogue is worse than no heading. */
  test('the section is absent when nothing matched', () => {
    const view = pages.slice(pages.indexOf('export const TeamPage'));
    expect(view.slice(0, view.indexOf('\n);\n'))).toContain(
      'ownChannels.matches.length || ownChannels.competition?.length',
    );
  });
});

describe('browsing the whole line', () => {
  test('/my/channels exists and is scoped to the session', () => {
    const i = app.indexOf("app.get('/my/channels'");
    expect(i).toBeGreaterThan(-1);
    const route = app.slice(i, app.indexOf('\n});', i));
    expect(route).toContain('requireUser(c)');
    expect(route).toContain('q.playlistGroups');
    expect(route).toContain('q.playlistKindCounts');
  });

  /*
   * The question underneath a report the sibling brand got: "my provider may not
   * have VOD at all". A line of live channels and a broken matcher look identical
   * from the outside, and only one of them is ours to fix.
   */
  test('it says outright when a line carries no files', () => {
    expect(pages).toContain("k.kind === 'vod' || k.kind === 'series'");
    expect(pages).toContain('it is all live channels');
  });

  test('rows of unknown kind are shown rather than folded into live', () => {
    expect(pages).toContain('not yet classified');
  });

  /* The provider's own words, never mapped onto our leagues -- see 0023. */
  test('groups are shown verbatim', () => {
    expect(pages).toContain("provider's own groupings");
  });
});
