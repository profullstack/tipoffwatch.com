import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';

// Set before the module graph reads it -- config snapshots the environment on import.
process.env.COINPAY_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { verifyWebhook } = await import('../packages/payments/src/index.js');

const sign = (body, t, secret = 'whsec_test_secret') =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('coinpay webhook verification', () => {
  const body = JSON.stringify({ id: 'pay_1', status: 'paid', metadata: { event_id: '5' } });
  const now = () => Math.floor(Date.now() / 1000);

  test('accepts a correctly signed, fresh webhook', () => {
    expect(verifyWebhook({ rawBody: body, signatureHeader: sign(body, now()) })).toBe(true);
  });

  test('rejects a tampered body', () => {
    const header = sign(body, now());
    const tampered = body.replace('"paid"', '"refunded"');
    expect(verifyWebhook({ rawBody: tampered, signatureHeader: header })).toBe(false);
  });

  test('rejects a signature made with the wrong secret', () => {
    expect(verifyWebhook({ rawBody: body, signatureHeader: sign(body, now(), 'wrong') })).toBe(false);
  });

  test('rejects a replay outside the tolerance window', () => {
    // A captured webhook replayed an hour later must not settle a payment again.
    expect(verifyWebhook({ rawBody: body, signatureHeader: sign(body, now() - 3600) })).toBe(false);
  });

  test('accepts one just inside the window and rejects one just outside', () => {
    expect(verifyWebhook({ rawBody: body, signatureHeader: sign(body, now() - 290) })).toBe(true);
    expect(verifyWebhook({ rawBody: body, signatureHeader: sign(body, now() - 310) })).toBe(false);
  });

  test('rejects malformed or absent headers', () => {
    for (const h of [undefined, '', 'garbage', 't=abc,v1=def', `t=${now()}`]) {
      expect(verifyWebhook({ rawBody: body, signatureHeader: h })).toBe(false);
    }
  });

  test('rejects a v1 of the wrong length without throwing', () => {
    // timingSafeEqual throws on length mismatch; the guard must swallow that.
    expect(verifyWebhook({ rawBody: body, signatureHeader: `t=${now()},v1=aa` })).toBe(false);
  });
});
