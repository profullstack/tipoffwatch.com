import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { Layout } = await import('../apps/web/src/views/Layout.jsx');
const { LeaguePage, NotFound, SportPage, SportsIndex, TeamPage } = await import(
  '../apps/web/src/views/pages.jsx'
);

const meta = async (node) => {
  const html = (await node.toString()).toString();
  return {
    description: html.match(/<meta name="description" content="([^"]*)"/)?.[1],
    og: html.match(/<meta property="og:description" content="([^"]*)"/)?.[1],
    ogTitle: html.match(/<meta property="og:title" content="([^"]*)"/)?.[1],
    ogUrl: html.match(/<meta property="og:url" content="([^"]*)"/)?.[1],
    ogSite: html.match(/<meta property="og:site_name" content="([^"]*)"/)?.[1],
    twitter: html.match(/<meta name="twitter:description" content="([^"]*)"/)?.[1],
    robots: html.match(/<meta name="robots" content="([^"]*)"/)?.[1] ?? null,
  };
};

const LEAGUE = { name: 'English Premier League', slug: 'soccer-eng-1', sport: 'soccer' };
const TEAM = {
  display_name: 'Arsenal',
  slug: 'ars',
  sport: 'soccer',
  league_name: 'English Premier League',
  league_slug: 'soccer-eng-1',
};

describe('every page describes itself', () => {
  /*
   * A crawl of fifty pages found one meta description repeated fifty times,
   * because only /about and /feeds ever passed one. Duplicate descriptions tell
   * an answer engine the pages are interchangeable: it keeps one and drops the
   * rest, and for this site "the rest" is the entire league and team catalogue.
   */
  test('the catalogue pages do not share a description', async () => {
    const found = await Promise.all([
      meta(SportsIndex({ user: null, sports: [] })),
      meta(SportPage({ user: null, sport: 'baseball', leagues: new Array(12) })),
      meta(
        LeaguePage({
          user: null,
          league: LEAGUE,
          teams: new Array(20),
          events: [],
          following: false,
        }),
      ),
      meta(TeamPage({ user: null, team: TEAM, events: [], following: false })),
    ]);
    const descriptions = found.map((f) => f.description);
    for (const d of descriptions) expect(d?.length ?? 0).toBeGreaterThan(50);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  test('the description names what is actually on the page', async () => {
    const league = await meta(
      LeaguePage({
        user: null,
        league: LEAGUE,
        teams: new Array(20),
        events: [],
        following: false,
      }),
    );
    expect(league.description).toContain('English Premier League');
    expect(league.description).toContain('20');

    const team = await meta(TeamPage({ user: null, team: TEAM, events: [], following: false }));
    expect(team.description).toContain('Arsenal');
  });
});

describe('share cards say the same thing the page does', () => {
  test('og and twitter descriptions track the meta description', async () => {
    const m = await meta(
      LeaguePage({
        user: null,
        league: LEAGUE,
        teams: new Array(20),
        events: [],
        following: false,
      }),
    );
    // One source, so a page cannot describe itself one way to a crawler and
    // another way to whoever pastes the link into a chat.
    expect(m.og).toBe(m.description);
    expect(m.twitter).toBe(m.description);
  });

  test('og:url and og:site_name are present on a canonical page', async () => {
    const m = await meta(
      LeaguePage({
        user: null,
        league: LEAGUE,
        teams: new Array(20),
        events: [],
        following: false,
      }),
    );
    expect(m.ogUrl).toContain('/leagues/soccer-eng-1');
    expect(m.ogSite).toBeTruthy();
  });

  test('og:title carries the page, not just the site', async () => {
    // It was the bare title before, so every shared link showed the same words.
    const m = await meta(TeamPage({ user: null, team: TEAM, events: [], following: false }));
    expect(m.ogTitle).toContain('Arsenal');
  });
});

describe('pages that should never be a search result say so', () => {
  test('the 404 is noindex', async () => {
    expect((await meta(NotFound({ user: null }))).robots).toContain('noindex');
  });

  test('an ordinary page is not', async () => {
    const m = await meta(TeamPage({ user: null, team: TEAM, events: [], following: false }));
    expect(m.robots).toBeNull();
  });

  test('noindex still follows, so the crawl is not dead-ended', async () => {
    // nofollow on a 404 would strand a crawler that reached it from a stale link
    // instead of letting it walk back into the site.
    expect((await meta(NotFound({ user: null }))).robots).toContain('follow');
  });
});

describe('the homepage', () => {
  test('still falls back to the site description', async () => {
    // The one page where "what this site is" IS the right description.
    const m = await meta(Layout({ user: null, children: 'x' }));
    expect(m.description).toBeTruthy();
  });
});
