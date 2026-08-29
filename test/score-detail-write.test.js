import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

/**
 * Getting a JSON document through the live tick's array literal.
 *
 * updateEventScores does not send rows; it sends one array per column through
 * `unnest`, because `from (values ${sql(rows)})` builds an INSERT's VALUES list and
 * fails at runtime inside an UPDATE ... FROM. That already froze every score on the
 * site for two hours once, so the statement is treated as load-bearing.
 *
 * score_detail rides in that statement as a `text[]` of JSON documents, cast to
 * jsonb on the way in. The risk is escaping rather than typing: a serialised
 * document is full of the characters a Postgres array literal reserves -- braces,
 * commas, double quotes -- and pgArray has to quote them or the whole statement
 * fails or, worse, silently writes a truncated document.
 *
 * So this proves the round trip through the real pgArray and a real Postgres,
 * rather than trusting that it looks right.
 */
let pgArray;
let db;
let leagueId;

const detail = {
  kind: 'tennis',
  games: [
    [7, 4, 5],
    [6, 6, 1],
  ],
  points: ['40', 'AD'],
  tiebreak: false,
  serving: 'home',
};

beforeAll(async () => {
  ({ pgArray } = await import('../packages/db/src/queries.js'));
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }

  // events.league_id is NOT NULL, so a fixture needs a competition to belong to.
  const { rows } = await db.query(
    `insert into leagues (provider, provider_key, slug, name, sport, priority)
     values ('livetennis', 'itf', 'tennis-itf', 'ITF', 'tennis', 8) returning id`,
  );
  leagueId = rows[0].id;
});

/** The one clause under test, kept to the shape updateEventScores uses. */
const writeDetail = async (values) =>
  db.query(
    `update events e set score_detail = v.score_detail::jsonb
       from (select * from unnest($1::text[], $2::text[]) as t(provider_key, score_detail)) v
      where e.provider_key = v.provider_key
      returning e.provider_key, e.score_detail`,
    [
      pgArray(values.map((v) => v.key)),
      pgArray(values.map((v) => (v.detail ? JSON.stringify(v.detail) : null))),
    ],
  );

describe('score_detail through the live tick', () => {
  test('the column exists and starts empty', async () => {
    await db.query(
      `insert into events (provider, provider_key, league_id, starts_at, state, name)
       values ('livetennis', 'livetennis/itf/1', $1, now(), 'in', 'A v B')`,
      [leagueId],
    );
    const { rows } = await db.query(`select score_detail from events where provider_key = $1`, [
      'livetennis/itf/1',
    ]);
    expect(rows[0].score_detail).toBe(null);
  });

  test('a whole document survives the array literal intact', async () => {
    // Braces, commas and quotes are exactly what a Postgres array literal reserves.
    const { rows } = await writeDetail([{ key: 'livetennis/itf/1', detail }]);
    expect(rows.length).toBe(1);

    const back =
      typeof rows[0].score_detail === 'string'
        ? JSON.parse(rows[0].score_detail)
        : rows[0].score_detail;
    expect(back).toEqual(detail);
  });

  test('it lands as real jsonb, not as a string that looks like one', async () => {
    // If it were written as text the cast would have failed or double-encoded, and
    // this is the cheapest way to tell those apart.
    const { rows } = await db.query(
      `select score_detail->>'kind' as kind,
              score_detail->'games'->0->>0 as first_set_away,
              jsonb_typeof(score_detail->'games') as games_type
         from events where provider_key = $1`,
      ['livetennis/itf/1'],
    );
    expect(rows[0]).toEqual({ kind: 'tennis', first_set_away: '7', games_type: 'array' });
  });

  test('null clears it, because a finished match sheds its points and server', async () => {
    const { rows } = await writeDetail([{ key: 'livetennis/itf/1', detail: null }]);
    expect(rows[0].score_detail).toBe(null);
  });

  test('a mixed batch writes each row its own answer', async () => {
    // The live tick sends every fixture in one statement -- tennis rows carrying a
    // document alongside ESPN rows carrying nothing.
    await db.query(
      `insert into events (provider, provider_key, league_id, starts_at, state, name)
       values ('espn', 'football/nfl/9', $1, now(), 'in', 'X at Y')`,
      [leagueId],
    );
    await writeDetail([
      { key: 'livetennis/itf/1', detail },
      { key: 'football/nfl/9', detail: null },
    ]);

    const { rows } = await db.query(
      `select provider_key, score_detail->>'kind' as kind from events order by provider_key`,
    );
    expect(rows).toEqual([
      { provider_key: 'football/nfl/9', kind: null },
      { provider_key: 'livetennis/itf/1', kind: 'tennis' },
    ]);
  });
});
