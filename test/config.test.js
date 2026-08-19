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
