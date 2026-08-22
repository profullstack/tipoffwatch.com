import { beforeAll, describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { verifyPassword } = await import('../packages/auth/src/password.js');
const { config } = await import('../packages/config/src/index.js');

/**
 * What a password sign-in gives away, which must be nothing.
 *
 * The login form is unauthenticated and anybody can post to it, so its answers are
 * readable by anybody. If a wrong password and an unknown address came back
 * differently -- in wording, or in how long they took -- the form would be an
 * address checker: post a list, keep whichever answers differ, and you have the
 * subscriber list.
 *
 * The data access is passed in rather than mocked at the module level. Mocking it
 * looked fine on its own and failed in the full suite, because importing password.js
 * binds the queries module and whichever test file imports it first wins; a mock
 * registered afterwards does nothing at all, quietly. What is under test here is the
 * decision logic -- password-login.test.js runs the real SQL against PGlite.
 */
let store;
let recorded;
let failureCount;

/** Stands in for @tipoff/db/queries, recording what it was asked to do. */
const db = {
  getUserForPassword: async (email) => store.get(String(email).toLowerCase()) ?? null,
  recordLoginAttempt: async ({ email, ok }) => {
    recorded.push({ email, ok });
  },
  recentFailedLogins: async () => failureCount,
  startSession: async () => 'session-id',
};

const attempt = (args) => verifyPassword(args, db);

beforeAll(async () => {
  store = new Map();
  recorded = [];
  failureCount = 0;

  store.set('real@example.test', {
    id: 'user-1',
    email: 'real@example.test',
    password_hash: await Bun.password.hash('a real password', { algorithm: 'argon2id' }),
  });
  // An account that exists but never opted in. Must be indistinguishable from an
  // address with no account at all.
  store.set('nopass@example.test', {
    id: 'user-2',
    email: 'nopass@example.test',
    password_hash: null,
  });
}, 60_000);

describe('a correct password', () => {
  test('signs in and starts a session', async () => {
    const out = await attempt({ email: 'real@example.test', password: 'a real password' });
    expect(out.ok).toBe(true);
    expect(out.sessionId).toBe('session-id');
  });

  test('is recorded as a success, so the limit resets', async () => {
    recorded = [];
    await attempt({ email: 'real@example.test', password: 'a real password' });
    expect(recorded.at(-1)).toEqual({ email: 'real@example.test', ok: true });
  });

  test('matches the address case-insensitively, and ignores surrounding space', async () => {
    const out = await attempt({ email: '  REAL@Example.test ', password: 'a real password' });
    expect(out.ok).toBe(true);
  });
});

describe('every failure looks the same', () => {
  test('wrong password, no password and no account are indistinguishable', async () => {
    const wrong = await attempt({ email: 'real@example.test', password: 'not it' });
    const noPassword = await attempt({ email: 'nopass@example.test', password: 'not it' });
    const noAccount = await attempt({ email: 'ghost@example.test', password: 'not it' });

    expect(wrong.ok).toBe(false);
    // Deep equality, not merely "all three are false": the wording is what leaks.
    expect(noPassword).toEqual(wrong);
    expect(noAccount).toEqual(wrong);
  });

  test('the message names neither the address nor the reason', async () => {
    const out = await attempt({ email: 'ghost@example.test', password: 'not it' });
    expect(out.error).not.toContain('ghost@example.test');
    expect(out.error.toLowerCase()).not.toContain('no account');
    expect(out.error.toLowerCase()).not.toContain('not found');
  });

  test('an account with no password cannot be entered with an empty one', async () => {
    for (const password of ['', null, undefined]) {
      expect((await attempt({ email: 'nopass@example.test', password })).ok).toBe(false);
    }
  });

  test('a missing account is still counted, so guessing at one is rate limited', async () => {
    recorded = [];
    await attempt({ email: 'ghost@example.test', password: 'not it' });
    expect(recorded.at(-1)).toEqual({ email: 'ghost@example.test', ok: false });
  });

  test('a stored hash that cannot be parsed is a refusal, not an exception', async () => {
    store.set('corrupt@example.test', { id: 'user-3', password_hash: 'not-a-hash' });
    const out = await attempt({ email: 'corrupt@example.test', password: 'anything at all' });
    expect(out.ok).toBe(false);
  });
});

describe('the decoy hash', () => {
  test('makes an unknown address cost real work', async () => {
    // If a missing account returned early it would answer in microseconds while a
    // wrong password took argon2 time, and the clock would answer the question the
    // wording refuses to. A floor, not a proof of constant time.
    const t0 = performance.now();
    await attempt({ email: 'ghost2@example.test', password: 'not it' });
    const unknown = performance.now() - t0;

    const t1 = performance.now();
    await attempt({ email: 'real@example.test', password: 'not it' });
    const known = performance.now() - t1;

    expect(unknown).toBeGreaterThan(known / 10);
  });

  test('never authenticates anything itself', async () => {
    // Even in the impossible case that somebody's password is the decoy input, it
    // must not be a way into an address that has no stored hash.
    const out = await attempt({
      email: 'ghost3@example.test',
      password: `decoy:${config.siteUrl}`,
    });
    expect(out.ok).toBe(false);
  });
});

describe('the throttle', () => {
  test('points at the emailed link rather than locking the account', async () => {
    // Flooding an address with guesses must never cost its owner the account. The
    // link is unguessable and unaffected by this counter, so it stays the way in.
    failureCount = 999;
    const out = await attempt({ email: 'real@example.test', password: 'a real password' });
    failureCount = 0;

    expect(out.ok).toBe(false);
    expect(out.throttled).toBe(true);
    expect(out.error.toLowerCase()).toContain('link');
  });

  test('refuses the correct password while throttled', async () => {
    // The point of the limit is that being right is not a way around it.
    failureCount = 999;
    const out = await attempt({ email: 'real@example.test', password: 'a real password' });
    failureCount = 0;
    expect(out.ok).toBe(false);
  });

  test('lets the right password through once the count is clear', async () => {
    expect((await attempt({ email: 'real@example.test', password: 'a real password' })).ok).toBe(
      true,
    );
  });
});
