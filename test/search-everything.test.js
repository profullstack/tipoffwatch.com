import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * The box in the header, and the five things behind it.
 *
 * Every query here is asserted against a real Postgres rather than against the
 * source text, because the interesting failures are all SQL: a filter that does
 * not scope by owner, a rank that puts the wrong row first, an index the predicate
 * cannot use. The two that ARE source assertions say so and explain why.
 */

let db;
const ids = {};

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const league = async (slug, name, abbr, sport, priority = 100) =>
    (
      await db.query(
        `insert into leagues (provider, provider_key, sport, slug, name, abbreviation, priority)
         values ('espn', $1, $2, $1, $3, $4, $5) returning id`,
        [slug, sport, name, abbr, priority],
      )
    ).rows[0].id;

  ids.mlb = await league('mlb', 'Major League Baseball', 'MLB', 'baseball', 1);
  ids.ncaa = await league('college-baseball', 'NCAA Baseball', 'NCAA', 'baseball', 50);
  ids.epl = await league('eng-1', 'English Premier League', 'EPL', 'soccer', 2);

  const team = async (slug, name, leagueId) =>
    (
      await db.query(
        `insert into teams (provider, provider_key, league_id, slug, name, display_name)
         values ('espn', $1, $2, $1, $3, $3) returning id`,
        [slug, leagueId, name],
      )
    ).rows[0].id;

  ids.jays = await team('blue-jays', 'Toronto Blue Jays', ids.mlb);
  ids.gators = await team('gators', 'Florida Gators', ids.ncaa);

  const event = async (key, leagueId, name, startsAt, state, timeKnown = true, home = null) =>
    (
      await db.query(
        `insert into events (provider, provider_key, league_id, starts_at, state, name,
                             time_known, home_team_id)
         values ('espn', $1, $2, $3, $4, $5, $6, $7) returning id`,
        [key, leagueId, startsAt, state, name, timeKnown, home],
      )
    ).rows[0].id;

  const inHours = (h) => new Date(Date.now() + h * 3600_000);

  ids.soon = await event(
    'e-soon',
    ids.mlb,
    'Blue Jays at Yankees',
    inHours(2),
    'pre',
    true,
    ids.jays,
  );
  ids.later = await event('e-later', ids.mlb, 'Blue Jays at Red Sox', inHours(9), 'pre');
  ids.undated = await event('e-undated', ids.ncaa, 'Regional Final', inHours(3), 'pre', false);
  ids.playing = await event('e-live', ids.epl, 'Arsenal at Chelsea', inHours(-1), 'in');
  ids.cupFinal = await event('e-cup', ids.epl, 'The FA Cup Final', inHours(400), 'pre');

  const user = async (email, handle, name, isPublic = true) =>
    (
      await db.query(
        `insert into users (email, handle, display_name, profile_public)
         values ($1, $2, $3, $4) returning id`,
        [email, handle, name, isPublic],
      )
    ).rows[0].id;

  ids.me = await user('me@example.com', 'chovy', 'Anthony');
  ids.other = await user('other@example.com', 'chovybot', 'Chovy Bot');
  ids.hidden = await user('hidden@example.com', 'chovyhidden', 'Hidden Chovy', false);
  ids.blocked = await user('blocked@example.com', 'chovyblocked', 'Blocked Chovy');
  await db.query('insert into user_blocks (blocker_id, blocked_id) values ($1, $2)', [
    ids.me,
    ids.blocked,
  ]);

  for (const [owner, tag] of [
    [ids.me, 'mine'],
    [ids.other, 'theirs'],
  ]) {
    const pl = (
      await db.query(
        `insert into user_playlists (user_id, label, source_url) values ($1, $2, 'sealed')
         returning id`,
        [owner, tag],
      )
    ).rows[0].id;
    await db.query(
      `insert into user_playlist_channels
         (playlist_id, position, title, group_title, kind, stream_url, norm_title)
       values ($1, 0, $2, 'Sports | US', 'live', 'sealed', $3)`,
      [pl, `Blue Jays Baseball (${tag})`, `blue jays baseball ${tag}`],
    );
  }
}, 60_000);

/* ------------------------------------------------------------- collections -- */

describe('finding a competition', () => {
  test('an abbreviation typed in full beats a name that merely shares letters', async () => {
    const q = 'ncaa';
    const rows = (
      await db.query(
        `select l.slug from leagues l
         where l.active
           and (lower(l.name) % $1 or lower(l.name) like $2 or lower(coalesce(l.abbreviation,'')) = $1)
         order by (lower(coalesce(l.abbreviation,'')) = $1) desc,
                  similarity(lower(l.name), $1) desc, l.priority, l.name`,
        [q, `%${q}%`],
      )
    ).rows;
    expect(rows[0].slug).toBe('college-baseball');
  });

  test('a partial name still matches', async () => {
    const q = 'premier';
    const rows = (
      await db.query(`select l.slug from leagues l where lower(l.name) like $1`, [`%${q}%`])
    ).rows;
    expect(rows.map((r) => r.slug)).toContain('eng-1');
  });
});

/* ----------------------------------------------------------------- people -- */

describe('finding a person', () => {
  const search = async (term, viewerId) =>
    (
      await db.query(
        `select u.handle::text as handle from users u
         where u.handle is not null and u.profile_public
           and (u.handle::text ilike $1 or u.display_name ilike $1)
           and not exists (select 1 from user_blocks b
                            where b.blocker_id = $2 and b.blocked_id = u.id)
         order by (u.handle::text ilike $3) desc, u.handle::text`,
        [`%${term}%`, viewerId, term],
      )
    ).rows.map((r) => r.handle);

  test('an exact handle comes first', async () => {
    expect((await search('chovy', ids.me))[0]).toBe('chovy');
  });

  test('a private profile is not listed', async () => {
    expect(await search('chovy', ids.me)).not.toContain('chovyhidden');
  });

  /* Appearing in the blocker's search results is exactly what blocking is for. */
  test('an account the viewer blocked is not listed', async () => {
    expect(await search('chovy', ids.me)).not.toContain('chovyblocked');
  });

  test('and is still listed to everybody else', async () => {
    expect(await search('chovy', ids.other)).toContain('chovyblocked');
  });
});

/* --------------------------------------------------------------- channels -- */

describe("searching a reader's own line", () => {
  const search = async (userId, needle) =>
    (
      await db.query(
        `select c.title from user_playlist_channels c
         join user_playlists p on p.id = c.playlist_id
         where p.user_id = $1 and c.norm_title like $2
         order by (c.is_live is false), length(c.title), c.position`,
        [userId, `%${needle}%`],
      )
    ).rows.map((r) => r.title);

  /*
   * The whole reason this is scoped through the playlist join rather than by an
   * id the caller passes: these rows are somebody's subscription, and one
   * account's search must never reach another account's list.
   */
  test('returns only the searcher’s own channels', async () => {
    const mine = await search(ids.me, 'blue jays');
    expect(mine).toEqual(['Blue Jays Baseball (mine)']);
    expect(mine.join()).not.toContain('theirs');
  });

  test('and nothing at all for an account with no list', async () => {
    expect(await search(ids.hidden, 'blue jays')).toEqual([]);
  });
});

/* ---------------------------------------------------------- starting soon -- */

describe('what starts in the next four hours', () => {
  const soon = async (hours = 4) =>
    (
      await db.query(
        `select e.name from events e
         where e.state = 'pre' and e.time_known
           and e.starts_at > now() and e.starts_at <= now() + ($1 * interval '1 hour')
         order by e.starts_at`,
        [hours],
      )
    ).rows.map((r) => r.name);

  test('includes a fixture inside the window', async () => {
    expect(await soon()).toContain('Blue Jays at Yankees');
  });

  test('excludes one outside it', async () => {
    expect(await soon()).not.toContain('Blue Jays at Red Sox');
  });

  /*
   * A date padded to a clock time is not a thing that "starts in three hours".
   * Counting down to an hour nobody chose is the one mistake time_known exists to
   * prevent, and it is the mistake the sibling brand would make on every
   * month-precision release if this filter were dropped.
   */
  test('excludes a row whose time we invented', async () => {
    expect(await soon()).not.toContain('Regional Final');
  });

  /* The live list is directly above this one on the page. */
  test('excludes anything already under way', async () => {
    expect(await soon()).not.toContain('Arsenal at Chelsea');
  });

  test('widening the window reaches further', async () => {
    expect(await soon(12)).toContain('Blue Jays at Red Sox');
  });
});

/* ------------------------------------------------------------- the markup -- */

describe('how the page is put together', () => {
  test('the header search is a plain GET form inside a search landmark', async () => {
    const layout = await readFile(
      new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(layout).toContain('<search class="topsearch">');
    expect(layout).toContain('method="get"');
    expect(layout).toContain('action="/search"');
    /*
     * No fetch, no keypress handler, no suggestion list. The box has to work
     * before app.js loads and with app.js blocked, which a scripted one does not.
     */
    expect(layout).not.toContain('onkeyup');
    expect(layout).not.toContain('fetch(');
  });

  test('the query is put back in the box on the results page', async () => {
    const layout = await readFile(
      new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(layout).toContain("value={props.q ?? ''}");
    const app = await readFile(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');
    expect(app).toContain('<SearchPage user={user} term={term}');
  });

  /*
   * A source assertion, because the risk is a future edit rather than the code as
   * written: the JSON endpoint is public and cached, and the page is neither. If
   * the two are ever made to share a query, one reader's channel list ends up in a
   * shared cache.
   */
  test('the public JSON search does not touch the private sources', async () => {
    const app = await readFile(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');
    const endpoint = app.slice(app.indexOf("app.get('/api/v1/search'"));
    const body = endpoint.slice(0, endpoint.indexOf('\n});'));
    expect(body).toContain('cache-control');
    expect(body).not.toContain('searchOwnChannels');
    expect(body).not.toContain('searchPeople');
  });
});
