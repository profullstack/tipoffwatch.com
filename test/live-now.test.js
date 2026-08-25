import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * "Live now" on the category page: what is in progress, for somebody who follows
 * nothing.
 *
 * Every other route into a fixture here assumes you have already picked a league
 * or a team. This one does not, which is the whole point of it -- so the thing
 * worth testing is not that a list renders but that the list is the RIGHT set: in
 * progress, everyone's, biggest competitions first.
 *
 * The SQL is lifted out of queries.js rather than restated, so an edit there runs
 * here instead of drifting from it.
 */
let db;
let liveSql;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  const source = await readFile(
    new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    'utf8',
  );
  /*
   * Anchored on `return sql` rather than on the function's closing brace. The
   * signature is destructured across several lines now that the query is scoped
   * by sport, league and team, so `\n}` matched the end of the PARAMETER list and
   * the extraction came back without any SQL in it at all.
   */
  const from = source.indexOf('export async function liveNow(');
  const inner = source.slice(from).match(/return sql`([\s\S]*?)`;/)[1];

  /*
   * The template placeholders become positional parameters, in the order the
   * query uses them. Regexes rather than string literals: the placeholders are
   * template syntax, and writing them as text trips the lint rule that looks for
   * accidental ones. Every one is replaced globally -- the scope predicates name
   * theirs twice (`is null or` ... `=` ...), and a first-match-only replace left
   * the second copy as literal text.
   */
  liveSql = inner
    .replace(/\$\{viewerId\}/g, '$1')
    .replace(/\$\{limit\}/g, '$2')
    .replace(/\$\{LIVE_MAX_STALENESS\}/g, '$3')
    .replace(/\$\{sport\}/g, '$4')
    .replace(/\$\{leagueId\}/g, '$5')
    .replace(/\$\{teamId\}/g, '$6');
}, 60_000);

/*
 * Seeded events take the table's `default now()` for updated_at, so they are
 * fresh and the staleness gate passes them. test/live-feed.test.js is where that
 * gate is exercised on its own.
 */
const run = async (viewerId = null, limit = 30, scope = {}) =>
  (
    await db.query(liveSql, [
      viewerId,
      limit,
      '30 minutes',
      scope.sport ?? null,
      scope.leagueId ?? null,
      scope.teamId ?? null,
    ])
  ).rows;

let leagueBig;
let leagueSmall;

async function seed() {
  await db.exec('delete from events; delete from follows; delete from teams; delete from leagues;');

  const league = async (slug, name, priority) =>
    (
      await db.query(
        `insert into leagues (provider, provider_key, slug, sport, name, abbreviation, priority)
         values ('espn', $1, $1, 'soccer', $2, upper($1), $3) returning id`,
        [slug, name, priority],
      )
    ).rows[0].id;

  leagueBig = await league('big', 'Big League', 10);
  leagueSmall = await league('small', 'Small League', 200);

  const team = async (leagueId, key, name) =>
    (
      await db.query(
        `insert into teams (provider, provider_key, league_id, slug, name, display_name)
         values ('espn', $1, $2, $1, $3, $3) returning id`,
        [key, leagueId, name],
      )
    ).rows[0].id;

  const home = await team(leagueBig, 'h1', 'Home');
  const away = await team(leagueBig, 'a1', 'Away');
  const homeS = await team(leagueSmall, 'h2', 'Home S');
  const awayS = await team(leagueSmall, 'a2', 'Away S');

  const event = async ({ key, leagueId, state, startsAt, h, a, broadcast = null }) =>
    (
      await db.query(
        `insert into events (provider, provider_key, league_id, name, starts_at, state,
                             home_team_id, away_team_id, broadcast)
         values ('espn', $1, $2, $1, $3, $4, $5, $6, $7) returning id`,
        [key, leagueId, startsAt, state, h, a, broadcast],
      )
    ).rows[0].id;

  return {
    liveSmall: await event({
      key: 'live-small',
      leagueId: leagueSmall,
      state: 'in',
      startsAt: new Date(Date.now() - 20 * 60_000),
      h: homeS,
      a: awayS,
    }),
    liveBig: await event({
      key: 'live-big',
      leagueId: leagueBig,
      state: 'in',
      startsAt: new Date(Date.now() - 5 * 60_000),
      h: home,
      a: away,
      broadcast: 'Apple TV',
    }),
    finished: await event({
      key: 'done',
      leagueId: leagueBig,
      state: 'post',
      startsAt: new Date(Date.now() - 3 * 60 * 60_000),
      h: home,
      a: away,
    }),
    postponed: await event({
      key: 'postponed',
      leagueId: leagueBig,
      // A postponement keeps `pre` with a start time in the past. leaguesWithLiveGames
      // deliberately picks these up -- it is choosing leagues to refresh, and a stale
      // `pre` is exactly what it wants corrected. This list must not: it says "live".
      state: 'pre',
      startsAt: new Date(Date.now() - 25 * 60_000),
      h: home,
      a: away,
    }),
    upcoming: await event({
      key: 'later',
      leagueId: leagueBig,
      state: 'pre',
      startsAt: new Date(Date.now() + 60 * 60_000),
      h: home,
      a: away,
    }),
  };
}

describe('what counts as live', () => {
  let ids;
  beforeAll(async () => {
    ids = await seed();
  });

  test('only games actually in progress', async () => {
    const got = (await run()).map((r) => Number(r.id)).sort();
    expect(got).toEqual([Number(ids.liveBig), Number(ids.liveSmall)].sort());
  });

  test('a fixture that kicked off but never started is not live', async () => {
    // The postponed case, and the reason this query does not borrow the live
    // tick's "or state = pre and starts_at is recent" widening: that widening
    // decides what to REFRESH, where being wrong costs one request. Here being
    // wrong tells somebody a match is on.
    const listed = (await run()).map((r) => Number(r.id));
    expect(listed).not.toContain(Number(ids.postponed));
  });

  test('the big competition comes first, not the one that kicked off earliest', async () => {
    // By kick-off the small league's game -- 20 minutes in against the big one's
    // 5 -- would lead, which is not what somebody scanning for something to watch
    // wants at the top.
    const rows = await run();
    expect(Number(rows[0].id)).toBe(Number(ids.liveBig));
    expect(rows[0].league_name).toBe('Big League');
  });

  test('it carries what the row needs, including where it is shown', async () => {
    const [first] = await run();
    expect(first.home_name).toBe('Home');
    expect(first.away_name).toBe('Away');
    expect(first.broadcast).toBe('Apple TV');
    expect(first.sport).toBe('soccer');
  });

  test('the limit caps the list', async () => {
    expect((await run(null, 1)).length).toBe(1);
  });
});

describe('whose list it is', () => {
  let ids;
  beforeAll(async () => {
    ids = await seed();
  });

  test('a signed-out reader sees every live game, not none', async () => {
    // The point of the feature: finding something to watch without following it
    // first. A follow filter here would empty the section for exactly the people
    // it was added for.
    expect((await run(null)).length).toBe(2);
  });

  test('following changes only the star, never the set', async () => {
    const userId = (await db.query(`insert into users (email) values ('a@b.c') returning id`))
      .rows[0].id;
    await db.query(
      `insert into follows (user_id, subject_type, subject_id) values ($1, 'league', $2)`,
      [userId, leagueBig],
    );

    const rows = await run(userId);
    expect(rows.length).toBe(2);
    const flagged = Object.fromEntries(rows.map((r) => [Number(r.id), r.following]));
    expect(flagged[Number(ids.liveBig)]).toBe(true);
    expect(flagged[Number(ids.liveSmall)]).toBe(false);
  });
});

describe('how the page says it', () => {
  const page = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );
  const components = readFileSync(
    new URL('../apps/web/src/views/components.jsx', import.meta.url).pathname,
    'utf8',
  );
  const app = readFileSync(new URL('../apps/web/src/app.js', import.meta.url).pathname, 'utf8');

  test('the section renders even when nothing is on', () => {
    // A section that appears only sometimes is indistinguishable from one that is
    // broken. The empty state is a sentence, not an absence.
    //
    // The markup moved into <LiveSection> when the drill-down pages started
    // carrying it too, so the guarantee is now asserted on the component: the
    // <section> is unconditional inside it, and the emptiness is handled by
    // EventList's emptyText rather than by not rendering.
    const section = page.slice(page.indexOf('export const LiveSection'));
    const body = section.slice(0, section.indexOf('\n);\n'));
    expect(body).toContain('<section class={`live-now');
    expect(body).toContain('emptyText={emptyText}');
    expect(body).not.toMatch(/events\.length \? \(\s*<section/);
    expect(page).toContain('emptyText={brand.copy.liveEmpty}');
  });

  test('the wording is per brand rather than a substituted noun', () => {
    // The genre site renders this same view. "3 releases in progress" is not
    // English, so whole sentences live in the brand file.
    expect(page).toContain('brand.copy.liveTitle');
    expect(page).toContain('brand.copy.liveBlurb');
    const brands = readFileSync(
      new URL('../packages/config/src/brands.js', import.meta.url).pathname,
      'utf8',
    );
    for (const key of ['liveTitle', 'liveBlurb', 'liveEmpty']) {
      // Once per brand, so neither site renders undefined.
      expect(brands.split(`${key}:`).length - 1).toBe(2);
    }
  });

  test('where to watch shows on the watch lists and nowhere else', () => {
    expect(components).toContain('showBroadcast && event.broadcast');
    /*
     * One, and only one, now that both lists render through <LiveSection>.
     *
     * It used to be two: Live now and Starting soon, each with its own copy of the
     * markup. Both exist to answer "what can I watch", which is the question a
     * channel name answers. Every OTHER EventList on the site is about when
     * something starts, and a broadcaster beside a kick-off time there is noise --
     * that is the regression this guards, and the component is now the single
     * place the flag is set, which is a stronger guarantee than counting was.
     */
    expect(page.match(/showBroadcast/g).length).toBe(1);
    const section = page.slice(page.indexOf('export const LiveSection'));
    expect(section.slice(0, section.indexOf('\n);\n'))).toContain('showBroadcast');
  });

  test('the page cache is short enough for a live score to be true', () => {
    // The live tick writes scores every 60s. The five-minute cache this page had
    // before the list arrived would serve a match that finished four minutes ago
    // as in progress.
    expect(app).toContain("cached(c, 'page:sports', 60,");
  });
});
