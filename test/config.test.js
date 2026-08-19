import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

describe('coinpay credential family', () => {
  test('accepts a merchant key and rejects an OAuth client id', async () => {
    const mod = await import('../packages/config/src/index.js');

    // The two families both start `cp` and only diverge at checkout, so this is
    // asserted at boot instead.
    process.env.COINPAY_API_KEY = `cp_live_${'a'.repeat(32)}`;
    const fresh = await import(`../packages/config/src/index.js?merchant=${Date.now()}`);
    expect(() => fresh.assertCoinpayMerchantKey()).not.toThrow();

    process.env.COINPAY_API_KEY = `cp_${'b'.repeat(24)}`;
    const oauth = await import(`../packages/config/src/index.js?oauth=${Date.now()}`);
    expect(() => oauth.assertCoinpayMerchantKey()).toThrow(/merchant/i);

    expect(typeof mod.config).toBe('object');
  });
});

describe('required variables', () => {
  test('a missing DATABASE_URL fails at boot, naming itself', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      // The regression this guards: `req('DATABASE_URL', 'postgres://localhost…')`
      // silently dialled localhost instead, so a service deployed without the
      // variable died seconds later with ERR_POSTGRES_CONNECTION_CLOSED — a driver
      // error that names neither the variable nor the service.
      await expect(import(`../packages/config/src/index.js?missing=${Date.now()}`)).rejects.toThrow(
        /DATABASE_URL/,
      );
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  test('REDIS_URL stays optional', async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const mod = await import(`../packages/config/src/index.js?noredis=${Date.now()}`);
      expect(mod.config.redisUrl).toContain('redis://');
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
  });
});
