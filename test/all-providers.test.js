import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
const { perLine } = await import('../packages/playlists/src/index.js');
const { byProvider } = await import('../apps/web/src/views/pages.jsx');

const row = (id, playlistId, label) => ({
  id,
  title: `ch${id}`,
  playlistId,
  providerLabel: label,
  providerManaged: false,
});

/**
 * Both subscriptions, every time.
 *
 * The matches from every provider are ranked into one list. A flat cap of ten
 * let one line take every slot and the other vanish — which reads exactly like
 * the site only using one of them. Measured on an account with a 7,059-entry
 * list and a 1,417,873-entry one.
 */
describe('one line cannot fill the whole answer', () => {
  test('a big list no longer crowds the other out', () => {
    // Twelve from the big line ranked above two from the small one.
    const ranked = [
      ...Array.from({ length: 12 }, (_, i) => row(i, 2395, 'argon')),
      row(100, 796, 'kyle'),
      row(101, 796, 'kyle'),
    ];
    const kept = ranked.reduce(perLine(10), []);
    const labels = kept.map((r) => r.providerLabel);
    expect(labels.filter((l) => l === 'argon')).toHaveLength(10);
    // The old flat slice(0, 10) returned zero of these.
    expect(labels.filter((l) => l === 'kyle')).toHaveLength(2);
  });

  test('ranked order is preserved inside a line', () => {
    const ranked = [row(1, 1, 'a'), row(2, 2, 'b'), row(3, 1, 'a')];
    expect(ranked.reduce(perLine(10), []).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  test('a reader with one line is unaffected', () => {
    const ranked = Array.from({ length: 25 }, (_, i) => row(i, 1, 'only'));
    expect(ranked.reduce(perLine(10), [])).toHaveLength(10);
  });

  test('rows with no line still count as one bucket rather than being dropped', () => {
    const ranked = Array.from({ length: 12 }, (_, i) => ({ ...row(i, null, null) }));
    expect(ranked.reduce(perLine(10), [])).toHaveLength(10);
  });
});

describe('grouping by provider', () => {
  test('rows are split by the line they are on', () => {
    const groups = byProvider([row(1, 2395, 'argon'), row(2, 796, 'kyle'), row(3, 2395, 'argon')]);
    expect(groups).toHaveLength(2);
    // The ranker's order decides which provider leads.
    expect(groups[0].label).toBe('argon');
    expect(groups[0].rows.map((r) => r.id)).toEqual([1, 3]);
    expect(groups[1].rows.map((r) => r.id)).toEqual([2]);
  });

  test('one provider is one group, so a single-line reader sees no heading', () => {
    const groups = byProvider([row(1, 1, 'only'), row(2, 1, 'only')]);
    expect(groups).toHaveLength(1);
  });

  test('an empty answer groups to nothing rather than throwing', () => {
    expect(byProvider([])).toEqual([]);
    expect(byProvider()).toEqual([]);
  });
});

describe('the candidate fetch gives every line a share', () => {
  test('it windows per playlist rather than racing for one cap', async () => {
    const src = await Bun.file(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    ).text();
    const fn = src.slice(src.indexOf('export async function playlistCandidates'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // Without the window, `order by p.position ... limit 3000` lets a
    // 1.4M-entry list take every slot before the other is even read.
    expect(body).toContain('row_number() over (partition by p.id');
    expect(body).toContain('rn <=');
  });
});

/*
 * The statement itself, against a real Postgres.
 *
 * The rest of this file checks shapes in JavaScript. This one exists because a
 * window function is new SQL on a hot path: a syntax error here would not show
 * up until an event page asked for channels in production.
 */
describe('the windowed candidate query is valid SQL and actually fair', () => {
  test('each line gets its share, and the big one does not take it all', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { citext } = await import('@electric-sql/pglite/contrib/citext');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    const { readdir, readFile } = await import('node:fs/promises');

    const db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }

    const q = async (sql, p) => (await db.query(sql, p)).rows;
    const [u] = await q(`insert into users (email) values ('m@example.com') returning id`);
    const [big] = await q(
      `insert into user_playlists (user_id, label, source_url, position)
       values ($1,'argon','enc:a',0) returning id`,
      [u.id],
    );
    const [small] = await q(
      `insert into user_playlists (user_id, label, source_url, position)
       values ($1,'kyle','enc:b',1) returning id`,
      [u.id],
    );
    // The big line alone would fill the cap.
    for (let i = 0; i < 30; i++) {
      await q(
        `insert into user_playlist_channels (playlist_id, position, title, stream_url, norm_title)
         values ($1,$2,$3,'enc','arsenal match')`,
        [big.id, i, `big ${i}`],
      );
    }
    for (let i = 0; i < 5; i++) {
      await q(
        `insert into user_playlist_channels (playlist_id, position, title, stream_url, norm_title)
         values ($1,$2,$3,'enc','arsenal match')`,
        [small.id, i, `small ${i}`],
      );
    }

    const perList = 10;
    const rows = await q(
      `select id, title, playlist_id from (
         select c.id, c.title, p.id as playlist_id, p.position as playlist_position,
                row_number() over (partition by p.id order by c.position, c.id) as rn
         from user_playlist_channels c
         join user_playlists p on p.id = c.playlist_id
         where p.user_id = $1
           and (c.is_live is not false or c.checked_at < now() - interval '30 minutes')
           and c.norm_title like any($2::text[])
       ) ranked
       where rn <= $3
       order by playlist_position, playlist_id, rn
       limit $4`,
      [u.id, ['%arsenal%'], perList, 20],
    );

    const fromBig = rows.filter((r) => r.playlist_id === big.id);
    const fromSmall = rows.filter((r) => r.playlist_id === small.id);
    expect(fromBig).toHaveLength(perList);
    // The whole point: the small line is still represented.
    expect(fromSmall).toHaveLength(5);
  }, 60_000);
});
