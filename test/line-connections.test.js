import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { lineAllowance } from '../packages/playlists/src/line.js';
import { lineInfo, panelApiUrl } from '../packages/playlists/src/panel.js';

/**
 * How many streams one line may carry at once.
 *
 * The proxy held every account to ONE open stream and evicted the older one
 * when a second started -- which is what "play in a new tab and the old tab
 * stops" was. That number is a fact about the reader's line, not about the
 * site, so it now comes from the line: the provider's panel is asked, the
 * reader can lower it, and the proxy enforces the smallest of those and the
 * site ceiling.
 */

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');

describe('finding the panel from the playlist address', () => {
  test('the query form', () => {
    expect(
      panelApiUrl('http://line.example.test/get.php?username=me&password=secret&type=m3u_plus'),
    ).toBe('http://line.example.test/player_api.php?username=me&password=secret');
  });

  test('the path form an XUI panel hands out', () => {
    expect(panelApiUrl('http://line.example.test/playlist/me/secret/m3u_plus')).toBe(
      'http://line.example.test/player_api.php?username=me&password=secret',
    );
    expect(panelApiUrl('http://line.example.test/get.php/me/secret/m3u')).toBe(
      'http://line.example.test/player_api.php?username=me&password=secret',
    );
  });

  test('keeps the port and the scheme', () => {
    expect(panelApiUrl('https://line.example.test:8080/playlist/u/p/m3u')).toBe(
      'https://line.example.test:8080/player_api.php?username=u&password=p',
    );
  });

  test('a bare stream url is not guessed at', () => {
    // /u/p/123 is what a STREAM looks like. Reading credentials out of it would
    // send somebody's password to whatever host that is.
    expect(panelApiUrl('http://line.example.test/me/secret/406464')).toBeNull();
  });

  test('a plain file, or garbage, is null', () => {
    expect(panelApiUrl('https://cdn.example.test/lists/mine.m3u')).toBeNull();
    expect(panelApiUrl('not a url')).toBeNull();
    expect(panelApiUrl('ftp://line.example.test/playlist/u/p/m3u')).toBeNull();
    expect(panelApiUrl('http://line.example.test/get.php?username=me')).toBeNull();
  });
});

describe('what the panel says', () => {
  const answer =
    (body, status = 200) =>
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

  test('numbers arrive as strings, and are read as numbers', async () => {
    const info = await lineInfo('http://line.example.test/playlist/me/secret/m3u', {
      fetch: answer({
        user_info: {
          username: 'me',
          status: 'Active',
          exp_date: '1893456000',
          active_cons: '1',
          max_connections: '2',
        },
      }),
    });
    expect(info).toEqual({
      maxConnections: 2,
      activeConnections: 1,
      status: 'Active',
      expiresAt: new Date(1893456000 * 1000),
    });
  });

  test('a line that does not expire, and a panel that will not say', async () => {
    const info = await lineInfo('http://line.example.test/playlist/me/secret/m3u', {
      fetch: answer({ user_info: { status: 'Active', exp_date: null } }),
    });
    expect(info).toEqual({
      maxConnections: null,
      activeConnections: null,
      status: 'Active',
      expiresAt: null,
    });
  });

  test('not a panel: null, never a throw', async () => {
    const url = 'http://line.example.test/playlist/me/secret/m3u';
    expect(await lineInfo(url, { fetch: answer('#EXTM3U\n') })).toBeNull();
    expect(await lineInfo(url, { fetch: answer({ ok: true }) })).toBeNull();
    expect(await lineInfo(url, { fetch: answer('nope', 403) })).toBeNull();
    expect(
      await lineInfo(url, {
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).toBeNull();
  });

  test('a plain file is not even asked', async () => {
    let asked = 0;
    const info = await lineInfo('https://cdn.example.test/mine.m3u', {
      fetch: async () => {
        asked += 1;
        return new Response('{}');
      },
    });
    expect(info).toBeNull();
    expect(asked).toBe(0);
  });

  test('is sent as the same client the import is, so the panel answers', async () => {
    let headers;
    await lineInfo('http://line.example.test/playlist/me/secret/m3u', {
      fetch: async (_url, init) => {
        headers = init.headers;
        return new Response('{}');
      },
    });
    expect(headers['user-agent']).toStartWith('curl/8.5.0');
  });
});

describe('the allowance is the quietest of three voices', () => {
  test('nothing known: one, which is what the proxy always enforced', () => {
    expect(lineAllowance(null, 4)).toBe(1);
    expect(lineAllowance({}, 4)).toBe(1);
    expect(lineAllowance({ line_connections: null, panel_connections: null }, 4)).toBe(1);
  });

  test('the panel speaks and the reader has not: the panel', () => {
    expect(lineAllowance({ line_connections: null, panel_connections: 2 }, 4)).toBe(2);
  });

  test('the reader may lower the panel', () => {
    expect(lineAllowance({ line_connections: 1, panel_connections: 3 }, 4)).toBe(1);
  });

  test('the reader may never raise it', () => {
    // Two streams on a line that permits one is what gets it suspended.
    expect(lineAllowance({ line_connections: 4, panel_connections: 1 }, 4)).toBe(1);
  });

  test('the reader speaks for a line whose panel would not', () => {
    expect(lineAllowance({ line_connections: 3, panel_connections: null }, 4)).toBe(3);
  });

  test('the site ceiling caps everything', () => {
    expect(lineAllowance({ line_connections: 8, panel_connections: 8 }, 4)).toBe(4);
    expect(lineAllowance({ line_connections: null, panel_connections: 10 }, 2)).toBe(2);
  });

  test('never below one, whatever arrives', () => {
    expect(lineAllowance({ line_connections: 0, panel_connections: 0 }, 4)).toBe(1);
    expect(lineAllowance({ line_connections: 'lots', panel_connections: -3 }, 4)).toBe(1);
    expect(lineAllowance({ line_connections: 2 }, 0)).toBe(1);
    expect(lineAllowance({ line_connections: 2 }, Number.NaN)).toBe(1);
  });

  test('a panel reporting 0 is treated as unknown, not as none', () => {
    // Some panels send "0" for an unlimited or unset value. Reading that as
    // "zero streams" would make the player refuse everything.
    expect(lineAllowance({ line_connections: null, panel_connections: 0 }, 4)).toBe(1);
    expect(lineAllowance({ line_connections: 3, panel_connections: 0 }, 4)).toBe(3);
  });
});

describe('the schema', () => {
  let db;
  let uid;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    uid = (await db.query(`insert into users (email) values ('a@example.test') returning id`))
      .rows[0].id;
    await db.query(
      `insert into user_playlists (user_id, label, source_url) values ($1, 'mine', 'sealed')`,
      [uid],
    );
  }, 60_000);

  test('a list starts with no chosen count and no panel word', async () => {
    const { rows } = await db.query(
      `select line_connections, panel_connections, panel_checked_at from user_playlists where user_id = $1`,
      [uid],
    );
    expect(rows[0]).toEqual({
      line_connections: null,
      panel_connections: null,
      panel_checked_at: null,
    });
  });

  test('the chosen count is held to the picker range', async () => {
    await expect(
      db.query(`update user_playlists set line_connections = 0 where user_id = $1`, [uid]),
    ).rejects.toThrow();
    await expect(
      db.query(`update user_playlists set line_connections = 9 where user_id = $1`, [uid]),
    ).rejects.toThrow();
    await db.query(`update user_playlists set line_connections = 4 where user_id = $1`, [uid]);
    await db.query(`update user_playlists set line_connections = null where user_id = $1`, [uid]);
  });

  test('what the panel said is stored beside it', async () => {
    await db.query(
      `update user_playlists set panel_connections = 2, panel_active = 1, panel_status = 'Active',
         panel_expires_at = now() + interval '30 days', panel_checked_at = now()
       where user_id = $1`,
      [uid],
    );
    const { rows } = await db.query(
      `select panel_connections, panel_active, panel_status from user_playlists where user_id = $1`,
      [uid],
    );
    expect(rows[0]).toEqual({ panel_connections: 2, panel_active: 1, panel_status: 'Active' });
  });
});

describe('the proxy asks the line, not the config', () => {
  const app = read('../apps/web/src/app.js');
  const cfg = read('../packages/config/src/index.js');
  const playlists = read('../packages/playlists/src/index.js');

  test('no stream route claims a slot against the site-wide number', () => {
    expect(app).not.toContain('max: config.playlists.proxy.maxPerUser');
  });

  test('a reader’s own stream is capped by their own line', () => {
    const own = app.slice(app.indexOf("app.get('/events/:id/stream.ts'"));
    expect(own.slice(0, own.indexOf('openStream('))).toContain(
      'max: await lineAllowanceFor(user.id)',
    );
    const mine = app.slice(app.indexOf("app.get('/my/channels/:channelId/stream.ts'"));
    expect(mine.slice(0, mine.indexOf('openStream('))).toContain(
      'max: await lineAllowanceFor(user.id)',
    );
  });

  test('a shared stream is capped by the OWNER’s line, refusal and claim alike', () => {
    const shared = app.slice(app.indexOf("app.get('/shared/:channelId/stream.ts'"));
    const body = shared.slice(0, shared.indexOf('openStream('));
    expect(body).toContain(
      'const ownerMax = lineAllowance(row, config.playlists.proxy.maxPerUser)',
    );
    expect(body).toContain('streamSlotsOpen(row.owner_id) >= ownerMax');
    expect(body).toContain('max: ownerMax');
  });

  test('the shared-channel query carries the owner’s two numbers', () => {
    const queries = read('../packages/db/src/queries.js');
    const fn = queries.slice(queries.indexOf('export async function sharedChannelById'));
    expect(fn.slice(0, fn.indexOf('return row'))).toContain(
      'p.line_connections, p.panel_connections',
    );
  });

  test('the config number is a ceiling of four, not a per-user one', () => {
    expect(cfg).toContain("maxPerUser: num('STREAM_PROXY_MAX_PER_USER', 4)");
  });

  test('the panel is asked after every import, changed or not', () => {
    // Both exits of importPlaylist -- the unchanged short-circuit and the full
    // import -- record the panel's word. A provider that upgrades a line to two
    // connections does not rewrite the playlist to say so.
    expect(playlists.split('await askPanel(userId, url);').length - 1).toBe(2);
    const unchanged = playlists.slice(playlists.indexOf('knownHash === contentHash'));
    expect(unchanged.slice(0, unchanged.indexOf('unchanged: true'))).toContain('askPanel');
  });

  test('a panel that cannot be read never fails the import', () => {
    const fn = playlists.slice(playlists.indexOf('async function askPanel'));
    const body = fn.slice(0, fn.indexOf('export async function lineAllowanceFor'));
    expect(body).toContain('try {\n    info = await lineInfo(url);\n  } catch');
    expect(body).toContain('await q.recordPanelInfo(');
    expect(body.indexOf('try {')).toBeLessThan(body.indexOf('await q.recordPanelInfo('));
  });

  test('the setting route clamps to the ceiling and clears on empty', () => {
    const route = app.slice(app.indexOf("app.post('/api/playlist/connections'"));
    const body = route.slice(0, route.indexOf('\n});'));
    expect(body).toContain('n < 1 || n > ceiling');
    expect(body).toContain("if (raw !== '')");
    expect(body).toContain('q.setLineConnections({ userId: user.id, connections })');
  });
});
