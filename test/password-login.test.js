import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { passwordProblem, MIN_LENGTH } = await import('../packages/auth/src/password.js');

/**
 * The optional password, and the properties that keep it from becoming the weak
 * point of an account that is otherwise link-and-passkey only.
 *
 * The rate-limit SQL is lifted out of queries.js and run as written rather than
 * restated here, the way following-flag.test.js does it, so an edit to the shipped
 * query is what gets tested.
 */
let db;
let recentFailuresSql;

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
  const at = source.indexOf('export async function recentFailedLogins(');
  expect(at).toBeGreaterThan(-1);
  const open = source.indexOf('sql`', at);
  const close = source.indexOf('`;', open);
  // Three bindings, and the address appears twice. A regex rather than a string
  // literal: these are template placeholders, and writing them as text trips the
  // lint rule that hunts for accidental ones.
  recentFailuresSql = source
    .slice(open + 4, close)
    .replace(/\$\{String\(email\)\.trim\(\)\.toLowerCase\(\)\}/g, '$1')
    .replace(/\$\{`\$\{minutes\} minutes`\}/, '$2');
}, 60_000);

const failures = async (email, minutes = 15) =>
  (await db.query(recentFailuresSql, [email, `${minutes} minutes`])).rows[0].n;

const attempt = (email, ok, ago = '0 minutes') =>
  db.query(`insert into login_attempts (email, ok, at) values ($1, $2, now() - $3::interval)`, [
    email,
    ok,
    ago,
  ]);

describe('what counts as a usable password', () => {
  test('too short is refused, and says how short', async () => {
    expect(passwordProblem('short')).toContain(String(MIN_LENGTH));
  });

  test('a reasonable one is accepted', async () => {
    expect(passwordProblem('correct horse battery')).toBe(null);
  });

  test('spaces alone are not a password', async () => {
    expect(passwordProblem('               ')).toBeTruthy();
  });

  test('your own address is not a password', async () => {
    // The most likely thing somebody types on a TV remote when hurried, and the
    // one guess an attacker who knows the address gets for free.
    expect(passwordProblem('anthony@example.com', { email: 'anthony@example.com' })).toBeTruthy();
    expect(passwordProblem('anthony', { email: 'anthony@example.com' })).toBeTruthy();
  });

  test('something absurdly long is refused rather than hashed', async () => {
    // Argon2id on a megabyte of input is a denial of service anyone can post for
    // free, so the ceiling is a refusal before any hashing happens.
    expect(passwordProblem('a'.repeat(5000))).toBeTruthy();
  });
});

describe('the rate limit', () => {
  test('counts recent failures for one address', async () => {
    await attempt('rate1@example.test', false);
    await attempt('rate1@example.test', false);
    expect(await failures('rate1@example.test')).toBe(2);
  });

  test('does not count another address', async () => {
    expect(await failures('nobody@example.test')).toBe(0);
  });

  test('forgets failures older than the window', async () => {
    await attempt('rate2@example.test', false, '40 minutes');
    expect(await failures('rate2@example.test')).toBe(0);
  });

  test('a success clears the slate somebody else filled', async () => {
    // Counted since the last SUCCESS rather than over a flat window. Otherwise an
    // attacker guessing at an address leaves its real owner one typo from a
    // lockout -- which would make the limit a weapon rather than a defence.
    await attempt('rate3@example.test', false, '5 minutes');
    await attempt('rate3@example.test', false, '4 minutes');
    expect(await failures('rate3@example.test')).toBe(2);
    await attempt('rate3@example.test', true, '3 minutes');
    expect(await failures('rate3@example.test')).toBe(0);
  });

  test('failures after that success count again', async () => {
    await attempt('rate3@example.test', false, '1 minute');
    expect(await failures('rate3@example.test')).toBe(1);
  });

  test('is case-insensitive about the address', async () => {
    // email is citext, and an attacker who could reset the counter by changing
    // capitalisation would have no limit at all.
    await attempt('Mixed@Example.test', false);
    expect(await failures('mixed@example.test')).toBe(1);
  });
});
