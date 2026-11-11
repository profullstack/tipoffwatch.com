import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const { LeaguePage, SportPage, SportsIndex, Following } = await import('../src/views/pages.jsx');
const { Feeds } = await import('../src/views/feeds.jsx');
const html = async (node) => String(await node.toString());

/*
 * The matcher lives in public/app.js, a plain browser script with no exports, so
 * the two pure helpers are pulled out of its source and evaluated on their own.
 */
const appSrc = readFileSync(new URL('../public/app.js', import.meta.url).pathname, 'utf8');
const grab = (name) => {
  const start = appSrc.indexOf(`function ${name}(`);
  const end = appSrc.indexOf('\n}\n', start);
  return appSrc.slice(start, end + 2);
};
const { listFilterWords, listFilterMatches } = new Function(
  `${grab('listFilterWords')}\n${grab('listFilterMatches')}\nreturn { listFilterWords, listFilterMatches };`,
)();
const matches = (text, q) => listFilterMatches(text, listFilterWords(q));

describe('list filter matcher', () => {
  test('every word, any order, any case', () => {
    expect(matches('Manchester City', 'city man')).toBe(true);
    expect(matches('Manchester City', 'MAN')).toBe(true);
    expect(matches('Manchester City', 'CiTy   MANCHESTER')).toBe(true);
    expect(matches('Manchester City', 'city united')).toBe(false);
    expect(matches('English Premier League', 'league prem')).toBe(true);
  });
  test('an empty query keeps every row', () => {
    expect(matches('Anything', '')).toBe(true);
    expect(matches('Anything', '   ')).toBe(true);
  });
});

describe('filter boxes on every league and team list', () => {
  const user = { id: 'u1', email: 'a@example.test' };
  const team = { id: 't1', slug: 'man-city', display_name: 'Manchester City', upcoming: 2 };
  const league = { id: 'l1', slug: 'eng.1', name: 'English Premier League', sport: 'soccer' };

  test('a league page filters its teams', async () => {
    const out = await html(
      <LeaguePage user={user} league={league} teams={[team]} events={[]} following={false} />,
    );
    expect(out).toContain('data-list-filter="teams-list"');
    expect(out).toContain('id="teams-list"');
    expect(out).toContain('data-filter="Manchester City"');
  });

  test('a sport page filters its leagues', async () => {
    const out = await html(<SportPage user={user} sport="soccer" leagues={[league]} />);
    expect(out).toContain('data-list-filter="leagues-list"');
    expect(out).toContain('data-filter="English Premier League"');
  });

  test('the sports index filters its sports', async () => {
    const out = await html(<SportsIndex user={null} sports={[{ sport: 'soccer', leagues: 3 }]} />);
    expect(out).toContain('data-list-filter="sports-list"');
    expect(out).toContain('id="sports-list"');
  });

  test('the feeds page filters sports and leagues', async () => {
    const out = await html(
      <Feeds
        user={null}
        sports={[{ sport: 'soccer', leagues: 3 }]}
        leagues={[{ ...league, upcoming: 4 }]}
      />,
    );
    expect(out).toContain('data-list-filter="feed-sports"');
    expect(out).toContain('data-list-filter="feed-leagues"');
  });

  test('following filters what you follow', async () => {
    const out = await html(
      <Following
        user={user}
        events={[]}
        follows={[{ subject_type: 'team', subject_id: 't1', label: 'Manchester City' }]}
      />,
    );
    expect(out).toContain('data-list-filter="follows-list"');
  });

  test('the box ships hidden so it never shows without JavaScript', async () => {
    const out = await html(<SportPage user={user} sport="soccer" leagues={[league]} />);
    expect(out).toMatch(/data-list-filter="leagues-list"[^>]*hidden/);
  });
});
