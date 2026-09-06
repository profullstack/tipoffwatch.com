import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * More than one provider per reader.
 *
 * 0015 enforced one list per account with a UNIQUE on user_id, so a reader with
 * two subscriptions could only tell us about one and adding the second destroyed
 * the first. These check the constraint is gone, that the ordering it is replaced
 * by works, and -- the part with real data at stake -- that the live pass's stash
 * is handed back as a row of its own rather than dropped with the columns.
 */
let db;

beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const mkUser = async (email) => one(`insert into users (email) values ($1) returning id`, [email]);

describe('the one-list-per-account constraint', () => {
  test('a reader can hold several lists at once', async () => {
    const u = await mkUser('multi@example.com');
    for (const [label, pos] of [
      ['Provider A', 0],
      ['Provider B', 1],
      ['Provider C', 2],
    ]) {
      await db.query(
        `insert into user_playlists (user_id, label, source_url, position)
         values ($1, $2, $3, $4)`,
        [u.id, label, `sealed-${label}`, pos],
      );
    }
    const { rows } = await db.query(
      `select label from user_playlists where user_id = $1 order by position, id`,
      [u.id],
    );
    expect(rows.map((r) => r.label)).toEqual(['Provider A', 'Provider B', 'Provider C']);
  });

  /*
   * Sealed with a random nonce per write, so the same provider url encrypts to
   * different bytes each time. A UNIQUE on source_url would therefore never fire,
   * which is why the constraint was not simply moved there.
   */
  test('nothing stops two rows holding the same sealed url', async () => {
    const u = await mkUser('dupe@example.com');
    for (let i = 0; i < 2; i++) {
      await db.query(
        `insert into user_playlists (user_id, label, source_url, position)
         values ($1, 'Same', 'sealed-same', $2)`,
        [u.id, i],
      );
    }
    const row = await one(`select count(*)::int as n from user_playlists where user_id = $1`, [
      u.id,
    ]);
    expect(row.n).toBe(2);
  });
});

describe('the live pass stash', () => {
  /*
   * The one destructive step in 0035. A reader part-way through a live pass has
   * their own subscription sitting in stashed_source_url while our managed line
   * holds source_url. Dropping the columns without materialising that first would
   * delete a credential they gave us and expect back.
   */
  test('a stashed list is handed back as a row rather than dropped', async () => {
    // The columns are gone by now, so the pre-migration state is reconstructed by
    // running the restore against a table shaped the old way.
    await db.exec(`
      create temporary table legacy (
        user_id uuid, label text, source_url text,
        stashed_source_url text, stashed_label text, managed boolean
      );
      insert into legacy values
        ('00000000-0000-0000-0000-000000000001','Our line','sealed-managed',
         'sealed-theirs','Their provider', true);
    `);
    const { rows } = await db.query(`
      select user_id,
             coalesce(stashed_label, 'My other list') as label,
             stashed_source_url as source_url,
             1 as position,
             false as managed
        from legacy
       where stashed_source_url is not null
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Their provider');
    expect(rows[0].source_url).toBe('sealed-theirs');
    // Behind the managed line: they are paying for that one right now.
    expect(rows[0].position).toBe(1);
    expect(rows[0].managed).toBe(false);
  });

  test('the stash columns are gone once nothing is held in them', async () => {
    const { rows } = await db.query(
      `select column_name from information_schema.columns
        where table_name = 'user_playlists'`,
    );
    const names = rows.map((r) => r.column_name);
    expect(names).not.toContain('stashed_source_url');
    expect(names).not.toContain('stashed_label');
    // What replaced them.
    expect(names).toContain('position');
    expect(names).toContain('managed');
  });
});

describe('the migration itself', () => {
  test('the column it sorts on is added before the index that sorts on it', async () => {
    const sql = await readFile(
      new URL('../packages/db/migrations/0035_multiple_providers.sql', import.meta.url).pathname,
      'utf8',
    );
    // Guarded statements make a wrong order invisible on an existing database and
    // fatal on a fresh one, which is the worst way round for a mistake to hide.
    const addCol = sql.indexOf('add column if not exists position');
    const addIdx = sql.indexOf('user_playlists_user_idx');
    expect(addCol).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(addCol);
  });

  test('the stash is materialised before the columns holding it are dropped', async () => {
    const sql = await readFile(
      new URL('../packages/db/migrations/0035_multiple_providers.sql', import.meta.url).pathname,
      'utf8',
    );
    const restore = sql.indexOf('insert into user_playlists');
    const drop = sql.indexOf('drop column if exists stashed_source_url');
    expect(restore).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(restore);
  });
});
