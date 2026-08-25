import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { LeagueTag } from '../apps/web/src/views/components.jsx';
import { CURATED_REGIONS, regionFor } from '../packages/sports/src/regions.js';

/**
 * "The one live game is miscategorised as NBA basketball."
 *
 * It was not. Sydney Kings at Illawarra Hawks is Australia's NBL: league slug
 * basketball-nbl, ESPN key basketball/nbl, team logos served from
 * espncdn.com/i/teamlogos/nbl/. Every fixture in the catalogue was checked
 * against the league its own teams belong to and none was misfiled.
 *
 * The label was still wrong to read, which is the same defect from outside. The
 * NBL's real name is "National Basketball League" -- one word from the NBA's
 * "National Basketball Association" -- shown as a four-letter chip one letter
 * from "NBA". So this file is about a chip identifying exactly one competition,
 * in the three ways it previously could not.
 */

/*
 * The component is called directly rather than written as JSX. `hono` is a
 * dependency of apps/web, not of the root workspace where bun test runs, so a
 * .jsx pragma here cannot resolve hono/jsx/jsx-dev-runtime -- and the component
 * is a plain function, so nothing is lost by calling it.
 */
const render = async (event) => {
  const node = LeagueTag({ event });
  // The component returns null for a league with nothing to say, which is the
  // behaviour one of the tests below is about.
  return node === null ? '' : String(await node.toString());
};

/* ------------------------------------------------------------ the reported -- */

describe('a chip that reads as another league', () => {
  test('the NBL says where it is', async () => {
    const html = await render({
      league_abbr: 'NBL',
      league_name: 'National Basketball League',
      league_region: 'Australia',
    });
    expect(html).toContain('NBL · Australia');
  });

  test('and the NBA, which needs no help, is left alone', async () => {
    // ESPN has no country for it and none is curated, so nothing is appended.
    const html = await render({
      league_abbr: 'NBA',
      league_name: 'National Basketball Association',
    });
    expect(html).toContain('>NBA<');
    expect(html).not.toContain('·');
  });

  test('the two are no longer one edit apart', async () => {
    const nbl = await render({
      league_abbr: 'NBL',
      league_name: 'National Basketball League',
      league_region: 'Australia',
    });
    const nba = await render({
      league_abbr: 'NBA',
      league_name: 'National Basketball Association',
    });
    expect(nbl).not.toBe(nba);
    expect(nbl).toContain('Australia');
  });
});

/* ------------------------------------------------- an abbreviation for many -- */

describe('an abbreviation that names nothing', () => {
  /*
   * Thirteen MMA promotions answer to "BFC" and there is no country for any of
   * them. A chip reading BFC is not short, it is a coin flip.
   */
  test('falls back to the full name when nothing else settles it', async () => {
    const html = await render({
      league_abbr: 'BFC',
      league_name: 'Battlezone Fighting Championship',
      league_abbr_ambiguous: true,
    });
    expect(html).toContain('Battlezone Fighting Championship');
    expect(html).not.toContain('>BFC<');
  });

  test('but keeps the short form when a region settles it', async () => {
    // Shorter than the full name and just as decisive, so it wins.
    const html = await render({
      league_abbr: 'ACB',
      league_name: 'Liga ACB',
      league_region: 'Spain',
      league_abbr_ambiguous: true,
    });
    expect(html).toContain('ACB · Spain');
  });

  test('an unambiguous abbreviation is still preferred over a long name', async () => {
    const html = await render({ league_abbr: 'NCAAB', league_name: "NCAA Men's Basketball" });
    expect(html).toContain('>NCAAB<');
  });

  test('the full name is always reachable on hover', async () => {
    const html = await render({
      league_abbr: 'NBL',
      league_name: 'National Basketball League',
      league_region: 'Australia',
    });
    expect(html).toContain('title="National Basketball League · Australia"');
  });

  test('a league with neither a name nor an abbreviation renders nothing', async () => {
    expect(await render({})).toBe('');
  });
});

/* ------------------------------------------------------- where regions come from -- */

describe('resolving a region', () => {
  test('curation beats the provider', () => {
    expect(regionFor('basketball/nbl', null)).toBe('Australia');
    expect(regionFor('basketball/nbl', 'Wrongland')).toBe('Australia');
  });

  test('the provider is used where there is no curated answer', () => {
    expect(regionFor('soccer/ita.1', 'Italy')).toBe('Italy');
  });

  /*
   * ESPN carries `country` for domestic soccer and NOWHERE else -- checked
   * against the live API for basketball, baseball, hockey and for continental
   * soccer competitions, all of which answer nothing. Null is the normal case
   * outside soccer, not a failure.
   */
  test('and null is a legitimate answer', () => {
    expect(regionFor('baseball/mlb', null)).toBeNull();
  });

  test('the curated table stays small enough to be read', () => {
    // The bar is "without this the chip names a DIFFERENT competition", not
    // "we happen to know where it is". A region nobody needed is clutter.
    expect(CURATED_REGIONS.size).toBeLessThanOrEqual(12);
  });
});

/* ------------------------------------------------------------- duplicates -- */

describe('the same competition under two provider keys', () => {
  let db;
  let dir;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    await db.exec(`
      insert into leagues (provider, provider_key, sport, slug, name, abbreviation, active, priority)
      values ('espn','soccer/concacaf.champions','soccer','soccer-concacaf-champions',
              'Concacaf Champions Cup','Concacaf Champions Cup', true, 100),
             ('espn','soccer/concacaf.champions_cup','soccer','soccer-concacaf-champions_cup',
              'CONCACAF Champions Cup','Conc CC', true, 100),
             ('espn','basketball/bfc-a','mma','mma-bfc-a','Alpha FC','BFC', true, 100),
             ('espn','basketball/bfc-b','mma','mma-bfc-b','Beta FC','BFC', true, 100),
             ('espn','basketball/nba','basketball','basketball-nba',
              'National Basketball Association','NBA', true, 1);
    `);
    /*
     * The migration already ran, against an empty leagues table -- so its
     * reconciliation is re-applied here, over the rows it is meant to act on.
     * The whole file is replayed rather than a copy of the statement, which is
     * both what makes this a test of the shipped SQL and a check that replaying
     * it is safe.
     */
    await db.exec(await readFile(`${dir}0025_league_region.sql`, 'utf8'));
  }, 120_000);

  /* The migration ships the reconciliation, keyed on provider_key so it means
   * the same thing on a laptop as in production. */
  test('the migration marks one as superseded by the other', async () => {
    const { rows } = await db.query(
      `select d.provider_key as dup, k.provider_key as keeps
       from leagues d join leagues k on k.id = d.superseded_by`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dup).toBe('soccer/concacaf.champions_cup');
    expect(rows[0].keeps).toBe('soccer/concacaf.champions');
  });

  test('re-running it changes nothing', async () => {
    await db.exec(await readFile(`${dir}0025_league_region.sql`, 'utf8'));
    const { rows } = await db.query(
      `select count(*)::int as n from leagues where superseded_by is not null`,
    );
    expect(rows[0].n).toBe(1);
  });

  test('the survivor is the one carrying the data', async () => {
    const { rows } = await db.query(
      `select provider_key from leagues where superseded_by is null and provider_key like 'soccer/concacaf%'`,
    );
    expect(rows.map((r) => r.provider_key)).toEqual(['soccer/concacaf.champions']);
  });

  /*
   * Not `active = false`, and this is the reason: upsertLeague sets active = true
   * on conflict, so the nightly catalogue sync would resurrect a row hidden that
   * way. superseded_by is never written by the sync.
   */
  test('a catalogue sync cannot resurrect it', async () => {
    await db.query(
      `insert into leagues (provider, provider_key, sport, slug, name, priority)
       values ('espn','soccer/concacaf.champions_cup','soccer','soccer-concacaf-champions_cup','x',100)
       on conflict (provider, provider_key) do update set sport = excluded.sport, active = true`,
    );
    const { rows } = await db.query(
      `select active, superseded_by is not null as hidden from leagues
       where provider_key = 'soccer/concacaf.champions_cup'`,
    );
    expect(rows[0].active).toBe(true);
    expect(rows[0].hidden).toBe(true);
  });
});

/* ------------------------------------------------------- draining the backlog -- */

describe('asking the provider where a league is', () => {
  let db;

  const DUE = `
    select provider_key from leagues
    where active and region is null
      and (region_checked_at is null or region_checked_at < now() - interval '30 days')
    order by region_checked_at nulls first, priority, id
    limit 2`;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    await db.exec(`
      insert into leagues (provider, provider_key, sport, slug, name, active, priority)
      values ('espn','a/1','baseball','a-1','One', true, 1),
             ('espn','a/2','hockey','a-2','Two', true, 2),
             ('espn','a/3','soccer','a-3','Three', true, 3),
             ('espn','a/4','soccer','a-4','Four', true, 4);
    `);
  }, 120_000);

  /*
   * The bug this column exists for. ESPN has no country outside domestic soccer,
   * so most of these can never resolve -- and a sweep that selects on `region is
   * null` alone hands back the same two every run while the rest are never seen.
   */
  test('a league with no country is not handed back forever', async () => {
    const first = (await db.query(DUE)).rows.map((r) => r.provider_key);
    expect(first).toEqual(['a/1', 'a/2']);

    // Asked, and the provider said nothing. The stamp still lands.
    await db.query(
      `update leagues set region = coalesce(null, region), region_checked_at = now()
       where provider_key = any($1)`,
      [first],
    );

    const second = (await db.query(DUE)).rows.map((r) => r.provider_key);
    expect(second).toEqual(['a/3', 'a/4']);
  });

  test('and the whole catalogue is walked before anything is revisited', async () => {
    await db.query(
      `update leagues set region_checked_at = now() where provider_key in ('a/3','a/4')`,
    );
    expect((await db.query(DUE)).rows).toHaveLength(0);
  });

  test('a resolved region is never asked about again', async () => {
    await db.query(
      `update leagues set region = 'Italy', region_checked_at = null where provider_key = 'a/3'`,
    );
    const due = (await db.query(DUE)).rows.map((r) => r.provider_key);
    expect(due).not.toContain('a/3');
  });
});

/* --------------------------------------------------------- the recompute -- */

describe('recomputing which abbreviations are ambiguous', () => {
  let db;

  const AMBIG = `
    with counted as (
      select abbreviation from leagues
      where active and superseded_by is null and abbreviation is not null
      group by abbreviation having count(*) > 1
    )
    update leagues l
       set abbr_ambiguous = coalesce(l.abbreviation in (select abbreviation from counted), false)
    returning l.abbreviation, l.abbr_ambiguous`;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    await db.exec(`
      insert into leagues (provider, provider_key, sport, slug, name, abbreviation, active, priority)
      values ('espn','a/1','mma','a-1','Alpha FC','BFC', true, 100),
             ('espn','a/2','mma','a-2','Beta FC','BFC', true, 100),
             ('espn','a/3','basketball','a-3','National Basketball Association','NBA', true, 1),
             ('espn','a/4','soccer','a-4','No Abbrev League', null, true, 100);
    `);
  }, 120_000);

  test('a shared abbreviation is flagged and a unique one is not', async () => {
    const { rows } = await db.query(AMBIG);
    const by = Object.fromEntries(rows.map((r) => [r.abbreviation ?? 'null', r.abbr_ambiguous]));
    expect(by.BFC).toBe(true);
    expect(by.NBA).toBe(false);
  });

  test('a null abbreviation is never ambiguous rather than null', async () => {
    // `x in (...)` is null when x is null, and a not-null column will not take it.
    const { rows } = await db.query(
      `select abbr_ambiguous from leagues where abbreviation is null`,
    );
    expect(rows[0].abbr_ambiguous).toBe(false);
  });

  test('a superseded duplicate does not make its survivor ambiguous', async () => {
    await db.query(
      `insert into leagues (provider, provider_key, sport, slug, name, abbreviation, active, priority)
       values ('espn','a/5','basketball','a-5','NBA clone','NBA', true, 100)`,
    );
    await db.query(
      `update leagues set superseded_by = (select id from leagues where provider_key='a/3')
       where provider_key = 'a/5'`,
    );
    await db.query(AMBIG);
    const { rows } = await db.query(
      `select abbr_ambiguous from leagues where provider_key = 'a/3'`,
    );
    expect(rows[0].abbr_ambiguous).toBe(false);
  });
});
