import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';

const { brand, config } = await import('../packages/config/src/index.js');
const live = await import('../packages/live/src/index.js');
const pay = await import('../packages/payments/src/index.js');
const {
  CHECKOUT_ASSETS,
  eventIdOf,
  formHtml,
  livePassCharge,
  livePassCheckout,
  livePassOptions,
  membershipCharge,
  membershipCheckout,
  membershipOptions,
  pageError,
} = await import('../apps/web/src/lib/checkout.js');

/**
 * The checkout form on /premium and /live (@profullstack/checkout).
 *
 * The form is a different way to press the same button. What is pinned here is
 * that it cannot charge anything the JSON routes do not: for every option, the
 * form's post opens the same CoinPay session (amount, description, metadata,
 * account, return addresses) as POST /api/membership/buy and POST /api/live/buy,
 * and that session is the one those routes opened before the form existed.
 */

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');
const user = { id: 'u1', email: 'buyer@example.test', handle: 'buyer' };
const site = config.siteUrl;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Wire the real payments module to a fake CoinPay and a database that records nothing. */
function coinpay() {
  const sql = (strings) => (Array.isArray(strings) ? [] : { __obj: strings });
  pay.configurePayments({
    sql,
    coinpay: {
      apiKey: `cp_live_${'a'.repeat(32)}`,
      businessId: 'biz_test',
      webhookSecret: 'whsec_test',
      baseUrl: 'https://coinpay.example',
      enabled: true,
    },
    siteUrl: site,
  });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ id: 'cs_abc123', url: 'https://coinpay.example/checkout/cs_abc123' }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  };
  return bodies;
}

/** The form, posted the way a browser on this site posts it. */
const post = (path, fields, headers = {}) =>
  new Request(`${site}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: site,
      referer: `${site}${path.replace('/checkout', '').split('?')[0]}`,
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });

describe('what is for sale', () => {
  test('premium is one term at the configured price', () => {
    expect(membershipOptions()).toEqual([
      {
        id: 'premium',
        name: 'A year',
        detail: '365 days',
        price: config.membership.priceCents / 100,
      },
    ]);
    expect(config.membership.priceCents).toBe(1000);
    expect(config.membership.termDays).toBe(365);
  });

  test('a pass is a week, a month or a year at the configured prices, the year selected', () => {
    const options = livePassOptions();
    expect(options.map((o) => [o.id, o.name, o.price])).toEqual([
      ['week', 'Week', 1],
      ['month', 'Month', 10],
      ['year', 'Year', 48],
    ]);
    expect(options.map((o) => o.detail)).toEqual(['7 days', '30 days', '365 days, $4 a month']);
    expect(options.filter((o) => o.default).map((o) => o.id)).toEqual(['year']);
    // Each is paid once for its days: no monthly plan, so no badge of any kind.
    for (const o of options) {
      expect(o.months).toBeUndefined();
      expect(o.popular).toBeUndefined();
    }
  });

  test('the form quotes exactly the configured cents and claims no saving', () => {
    const start = async () => ({ checkoutUrl: 'https://coinpay.example/checkout/cs_x' });
    const passes = livePassCheckout({ user, start });
    expect(passes.config.options.map((o) => [o.id, o.chargeCents])).toEqual([
      ['week', config.live.weekCents],
      ['month', config.live.monthCents],
      ['year', config.live.yearCents],
    ]);
    const html = formHtml(passes, { query: {}, user });
    expect(html).not.toContain('Save ');
    expect(html).not.toContain('Most popular');
    expect(html).toContain('value="year" checked');

    const premium = membershipCheckout({ user, start });
    expect(premium.config.options.map((o) => [o.id, o.chargeCents])).toEqual([
      ['premium', config.membership.priceCents],
    ]);
  });
});

describe('the session a purchase opens', () => {
  test('premium: what the JSON route has always sent', () => {
    expect(membershipCharge(user)).toEqual({
      user,
      email: 'buyer@example.test',
      accountId: 'u1',
      amountCents: 1000,
      currency: 'USD',
      description: `${brand.name} premium, 365 days`,
      metadata: { kind: 'membership' },
      successUrl: `${site}/premium?paid=1`,
      cancelUrl: `${site}/premium`,
    });
  });

  test('a pass: what the JSON route has always sent, with and without a game', () => {
    const table = { week: [100, 7], month: [1000, 30], year: [4800, 365] };
    for (const [key, [cents, days]] of Object.entries(table)) {
      expect(livePassCharge(user, live.planFor(key))).toEqual({
        user,
        email: 'buyer@example.test',
        accountId: 'u1',
        amountCents: cents,
        currency: 'USD',
        description: `${brand.name} Live TV, ${days} days`,
        metadata: { kind: 'live_pass', plan: key },
        successUrl: `${site}/live?paid=1`,
        cancelUrl: `${site}/live`,
      });
    }
    const fromGame = livePassCharge(user, live.planFor('week'), 74799);
    expect(fromGame.successUrl).toBe(`${site}/live?paid=1&event=74799`);
    expect(fromGame.cancelUrl).toBe(`${site}/events/74799`);
  });

  test('a game id is a positive integer or nothing', () => {
    expect(eventIdOf('74799')).toBe(74799);
    for (const junk of [undefined, '', '0', '-3', '1.5', 'abc', '7;drop']) {
      expect(eventIdOf(junk)).toBeNull();
    }
  });

  test('the JSON routes open the session these functions describe', () => {
    const app = read('../apps/web/src/app.js');
    const body = (start) => {
      const from = app.slice(app.indexOf(start));
      return from.slice(0, from.indexOf('\n});'));
    };
    expect(body("app.post('/api/membership/buy'")).toContain(
      'await pay.createCheckout(membershipCharge(user))',
    );
    const pass = body("app.post('/api/live/buy'");
    expect(pass).toContain("const plan = live.planFor(String(body.plan ?? ''))");
    expect(pass).toContain('livePassCharge(user, plan, eventIdOf(body.event))');
  });
});

describe('the form opens the same session as the JSON route', () => {
  test('premium', async () => {
    const bodies = coinpay();
    await pay.createCheckout(membershipCharge(user));
    const res = await membershipCheckout({ user, start: pay.createCheckout }).POST(
      post('/checkout/premium', { option: 'premium' }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://coinpay.example/checkout/cs_abc123');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1].amount).toBe(10);
    expect(bodies[1].metadata.kind).toBe('membership');
    expect(bodies[1].account_id).toBe('u1');
  });

  for (const [key, amount] of [
    ['week', 1],
    ['month', 10],
    ['year', 48],
  ]) {
    test(`a ${key} pass, from the page and from a game`, async () => {
      for (const eventId of [null, 74799]) {
        const bodies = coinpay();
        await pay.createCheckout(livePassCharge(user, live.planFor(key), eventId));
        const path = `/checkout/live${eventId ? `?event=${eventId}` : ''}`;
        const res = await livePassCheckout({ user, eventId, start: pay.createCheckout }).POST(
          post(path, { option: key }),
        );
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('https://coinpay.example/checkout/cs_abc123');
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toEqual(bodies[0]);
        expect(bodies[1].amount).toBe(amount);
        expect(bodies[1].metadata).toMatchObject({ kind: 'live_pass', plan: key, user_id: 'u1' });
      }
    });
  }
});

describe('what the form refuses', () => {
  const never = () => {
    throw new Error('a session was opened');
  };

  test('an amount that is no longer the price opens nothing', async () => {
    let opened = 0;
    const start = async () => {
      opened += 1;
      return { checkoutUrl: 'https://coinpay.example/checkout/cs_x' };
    };
    const checkout = livePassCheckout({ user, start });
    const was = config.live.yearCents;
    config.live.yearCents = was + 100;
    try {
      const res = await checkout.POST(post('/checkout/live', { option: 'year' }));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/live?option=year&error=payment_unavailable');
    } finally {
      config.live.yearCents = was;
    }
    expect(opened).toBe(0);
  });

  test('a pass that is not for sale', async () => {
    const res = await livePassCheckout({ user, start: never }).POST(
      post('/checkout/live', { option: 'decade' }),
    );
    expect(res.headers.get('location')).toBe('/live?option=decade&error=invalid_option');
  });

  test('nobody signed in: sent to sign in and back, with the pass and the game kept', async () => {
    const res = await livePassCheckout({ user: null, eventId: 74799, start: never }).POST(
      post('/checkout/live?event=74799', { option: 'month' }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      `/login?next=${encodeURIComponent('/live?option=month&event=74799')}`,
    );
    const premium = await membershipCheckout({ user: null, start: never }).POST(
      post('/checkout/premium', { option: 'premium' }),
    );
    expect(premium.headers.get('location')).toBe(
      `/login?next=${encodeURIComponent('/premium?option=premium')}`,
    );
  });

  test('the buyer is the session, whatever the form says', async () => {
    const bodies = coinpay();
    await membershipCheckout({ user, start: pay.createCheckout }).POST(
      post('/checkout/premium', {
        option: 'premium',
        email: 'someone-else@example.test',
        account_id: 'u2',
        amount: '0.01',
      }),
    );
    expect(bodies[0].customer_email).toBe('buyer@example.test');
    expect(bodies[0].account_id).toBe('u1');
    expect(bodies[0].amount).toBe(10);
  });

  test('a post from another site', async () => {
    const checkout = membershipCheckout({ user, start: never });
    const form = await checkout.POST(
      post('/checkout/premium', { option: 'premium' }, { origin: 'https://evil.example' }),
    );
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toContain('error=bad_origin');
    const json = await checkout.POST(
      post(
        '/checkout/premium',
        { option: 'premium' },
        { origin: 'https://evil.example', accept: 'application/json' },
      ),
    );
    expect(json.status).toBe(403);
  });
});

describe('the form on the page', () => {
  const start = async () => ({ checkoutUrl: 'https://coinpay.example/checkout/cs_x' });

  test('is a section of the page: a second-level heading, never a second <h1>', () => {
    const html = formHtml(membershipCheckout({ user, start }), { query: {}, user });
    expect(html).toContain('<h2 class="pfc-title">Join</h2>');
    expect(html).not.toContain('<h1');
    expect(html).toContain('action="/checkout/premium"');
    expect(html).toContain('Continue to payment');
    expect(html).toContain('buyer@example.test');
  });

  test('carries the game on its own address, and the link can pick the pass', () => {
    const checkout = livePassCheckout({ user, eventId: 74799, start });
    const html = formHtml(checkout, { query: { plan: 'week', event: '74799' }, user });
    expect(html).toContain('action="/checkout/live?event=74799"');
    expect(html).toContain('value="week" checked');
    expect(html).not.toContain('value="year" checked');
  });

  test('signed out it asks for no email and says where the button goes', () => {
    const html = formHtml(livePassCheckout({ user: null, start }), { query: {}, user: null });
    expect(html).not.toContain('type="email"');
    expect(html).toContain('Sign in to buy');
    expect(html).not.toContain('Continue to payment');
  });

  test('says nothing that is not already true here: no em dash, no promise to refund', () => {
    for (const checkout of [
      membershipCheckout({ user, start }),
      livePassCheckout({ user, start }),
    ]) {
      const html = formHtml(checkout, { query: {}, user });
      expect(html).not.toContain('—');
      expect(html.toLowerCase()).not.toContain('guarantee');
      expect(html.toLowerCase()).not.toContain('cancel anytime');
    }
  });

  test('a code from a failed post is the form’s to print, free text is the page’s', () => {
    expect(pageError('payment_unavailable')).toBeNull();
    expect(pageError('bad_origin')).toBeNull();
    expect(pageError(undefined)).toBeNull();
    expect(pageError('Pick a pass.')).toBe('Pick a pass.');
  });

  test('its stylesheet and script are our own files, linked by content hash', () => {
    expect(CHECKOUT_ASSETS.css.href).toBe(`/vendor-checkout.css?v=${CHECKOUT_ASSETS.css.hash}`);
    expect(CHECKOUT_ASSETS.js.href).toBe(`/vendor-checkout.js?v=${CHECKOUT_ASSETS.js.hash}`);
    expect(CHECKOUT_ASSETS.css.type).toContain('text/css');
    expect(String(CHECKOUT_ASSETS.css.body)).toContain('.pfc');
    expect(String(CHECKOUT_ASSETS.js.body)).toContain('mountCheckout');
  });
});
