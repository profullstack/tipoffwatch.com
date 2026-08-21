import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const rows = async (sql, params) => (await db.query(sql, params)).rows;

async function seedEvent({ timeKnown = true, precision = 'minute', minutesAway = 60 }) {
  const [l] = await rows(
    `insert into leagues (provider, provider_key, sport, slug, name)
     values ('t',$1,'soccer',$1,'L') returning id`,
    [`l${Math.random()}`],
  );
  const at = new Date(Date.now() + minutesAway * 60_000);
  const [e] = await rows(
    `insert into events (provider, provider_key, league_id, starts_at, name, time_known, precision)
     values ('t',$1,$2,$3,'E',$4,$5) returning id`,
    [`e${Math.random()}`, l.id, at, timeKnown, precision],
  );
  return e.id;
}

/** Mirrors eventsDueForReminder. */
const due = (offsetMinutes, timed) =>
  rows(
    `select e.id from events e
     where e.state = 'pre'
       and e.time_known = $2
       and e.precision in ('second','minute','hour','day')
       and e.starts_at - ($1 * interval '1 minute') <= now()
       and e.starts_at - ($1 * interval '1 minute') > now() - (300 * interval '1 second')`,
    [offsetMinutes, timed],
  );

describe('the migration is additive', () => {
  // Every fixture already stored has a kickoff, so nothing about sport changes.
  test('existing rows default to a known time', async () => {
    const id = await seedEvent({});
    const [r] = await rows(`select time_known, precision from events where id=$1`, [id]);
    expect(r.time_known).toBe(true);
    expect(r.precision).toBe('minute');
  });

  test('existing preferences default to sensible date offsets', async () => {
    const [u] = await rows(`insert into users (email) values ($1) returning id`, [
      `u${Math.random()}@x.com`,
    ]);
    await db.query(`insert into reminder_prefs (user_id) values ($1)`, [u.id]);
    const [p] = await rows(
      `select offsets_minutes, date_offsets_minutes from reminder_prefs
                            where user_id=$1`,
      [u.id],
    );
    expect(p.offsets_minutes).toEqual([60, 1]);
    expect(p.date_offsets_minutes).toEqual([1440, 0]);
  });
});

describe('the two reminder classes never cross', () => {
  test('a timed scan does not match a date-only event', async () => {
    const id = await seedEvent({ timeKnown: false, precision: 'day' });
    expect((await due(60, true)).map((r) => r.id)).not.toContain(id);
    expect((await due(60, false)).map((r) => r.id)).toContain(id);
  });

  test('a dated scan does not match a fixture with a kickoff', async () => {
    const id = await seedEvent({ timeKnown: true });
    expect((await due(60, false)).map((r) => r.id)).not.toContain(id);
    expect((await due(60, true)).map((r) => r.id)).toContain(id);
  });

  test('a month- or year-precision date is never remindable', async () => {
    const m = await seedEvent({ timeKnown: false, precision: 'month' });
    const y = await seedEvent({ timeKnown: false, precision: 'year' });
    const ids = (await due(60, false)).map((r) => r.id);
    expect(ids).not.toContain(m);
    expect(ids).not.toContain(y);
  });
});

describe('the lateness guard', () => {
  /*
   * It was dead. The scan enqueued `startsAt: e.startsAt` while the query returns
   * `starts_at` and there is no camelCase transform, so the value was undefined --
   * which makes dueAt NaN in the fan-out, and `NaN > maxLateness` is false. Every
   * backlogged reminder was delivered however late, which is the exact thing the
   * guard exists to prevent.
   */
  test('the scan enqueues the column the query actually returns', async () => {
    const src = await readFile(
      new URL('../packages/queue/src/workers.js', import.meta.url).pathname,
      'utf8',
    );
    expect(src).toContain('startsAt: e.starts_at');
    expect(src).not.toContain('startsAt: e.startsAt');
  });

  test('an undefined start time silently disables the guard, which is why', () => {
    const maxLateness = 300;
    const broken = (Date.now() - (new Date(undefined).getTime() - 60 * 60_000)) / 1000;
    expect(Number.isNaN(broken)).toBe(true);
    expect(broken > maxLateness).toBe(false);

    const fixed = (Date.now() - (new Date(Date.now() - 3600_000).getTime() - 60 * 60_000)) / 1000;
    expect(fixed > maxLateness).toBe(true);
  });
});
