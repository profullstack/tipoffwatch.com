import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { formHtml, membershipCheckout } = await import('../apps/web/src/lib/checkout.js');
const { InvitePage, PremiumPage } = await import('../apps/web/src/views/premium.jsx');

/**
 * The two pages that talk about money.
 *
 * What is pinned here is not layout. It is that every figure on the page comes
 * from the value it was handed -- a price written into the markup is a price that
 * will one day be advertised at one number and charged at another -- and that the
 * page never offers a control it cannot honour: no checkout without an account,
 * no join button when payments are switched off.
 */

const base = {
  user: { id: 'u1', handle: 'chovy', display_name: 'Anthony' },
  membership: null,
  priceCents: 1000,
  currency: 'USD',
  termDays: 365,
  commissionBps: 2000,
  freeHistoryDays: 30,
  paymentsEnabled: true,
  inviteUrl: 'https://tipoffwatch.com/i/abc123',
  invited: [],
  earnings: [],
  ledger: [],
};

/** The form the route hands the page: built for whoever is signed in, as /premium does. */
const formFor = ({ user, membership }) =>
  formHtml(
    membershipCheckout({
      user: user ? { ...user, email: 'chovy@example.test' } : null,
      renewing: Boolean(membership),
      start: async () => ({ checkoutUrl: 'https://coinpay.example/checkout/cs_x' }),
    }),
    { query: {}, user: user ? { email: 'chovy@example.test' } : null },
  );

const render = async (props) => {
  const all = { ...base, ...props };
  const checkout = all.paymentsEnabled ? formFor(all) : null;
  return String(await PremiumPage({ checkout, ...all }).toString());
};

describe('what the page says it costs', () => {
  test('the price and the rate are the ones it was handed', async () => {
    const html = await render({});
    expect(html).toContain('$10.00');
    expect(html).toContain('20%');
    expect(html).toContain('a year');
  });

  test('a different price is a different page, with nothing hardcoded left over', async () => {
    const html = await render({ priceCents: 2500, commissionBps: 1500, termDays: 30 });
    expect(html).toContain('$25.00');
    expect(html).toContain('15%');
    expect(html).toContain('a month');
    expect(html).not.toContain('$10.00');
    expect(html).not.toContain('20%');
  });

  test('an odd term is said in days rather than rounded into a lie', async () => {
    expect(await render({ termDays: 90 })).toContain('90 days');
  });

  test('all three features are named', async () => {
    const html = await render({});
    expect(html).toContain('Share streams with your friends');
    expect(html).toContain('Private messaging history');
    expect(html).toContain('the people you invite');
  });
});

describe('controls it can actually honour', () => {
  test('signed out, the one button is a way to sign in, never a way to pay', async () => {
    // The webhook credits an account. A signed-out checkout would take money and
    // have nowhere to put the membership: the form's post goes to sign in and
    // back (test/checkout-form.test.js), and its button says so.
    const html = await render({ user: null, inviteUrl: null });
    expect(html).toContain('Sign in to join');
    expect(html).not.toContain('Continue to payment');
    expect(html).not.toContain('action="/api/membership/buy"');
  });

  test('signed in, the form sells the term: one option, one button, the amount due', async () => {
    const html = await render({});
    expect(html).toContain('action="/checkout/premium"');
    expect(html).toContain('<h2 class="pfc-title">Join</h2>');
    expect(html).toContain('name="option" value="premium" checked');
    expect(html).toContain('USD 10.00');
    expect(html).toContain('Continue to payment');
    expect(html).toContain('It does not renew itself');
    // One <h1> on the page: the form is a section of it.
    expect(html.match(/<h1/g)?.length).toBe(1);
    // The package's own files, from this origin; nothing inline.
    expect(html).toMatch(/<link rel="stylesheet" href="\/vendor-checkout\.css\?v=[0-9a-f]+"/);
    expect(html).toMatch(/<script type="module" src="\/vendor-checkout\.js\?v=[0-9a-f]+"/);
  });

  test('no form when payments are switched off', async () => {
    const html = await render({ paymentsEnabled: false });
    expect(html).not.toContain('action="/checkout/premium"');
    expect(html).not.toContain('pfc-cta');
    expect(html).toContain('not switched on');
  });

  test('a member is offered a renewal, and told it stacks', async () => {
    const html = await render({
      membership: { expires_at: new Date('2027-01-01T00:00:00Z').toISOString() },
    });
    expect(html).toContain('<h2 class="pfc-title">Renew</h2>');
    expect(html).toContain('action="/checkout/premium"');
    expect(html).toContain('adds another');
  });

  test('a signed-out visitor is not shown an empty earnings box', async () => {
    const html = await render({ user: null, inviteUrl: null });
    expect(html).not.toContain('Your invite link');
    expect(html).not.toContain('People you brought in');
  });
});

describe('earnings', () => {
  test('each currency is reported on its own, never added together', async () => {
    const html = await render({
      earnings: [
        { currency: 'USD', n: 3, accrued_cents: 600, paid_cents: 0 },
        { currency: 'EUR', n: 1, accrued_cents: 200, paid_cents: 0 },
      ],
    });
    expect(html).toContain('$6.00');
    expect(html).toContain('€2.00');
    // $8.00 would be the number a naive sum produces, and it is not a real amount
    // of anything.
    expect(html).not.toContain('$8.00');
  });

  test('nothing earned says why, rather than showing a zero', async () => {
    const html = await render({});
    expect(html).toContain('not when they sign up');
  });
});

describe('the invite page', () => {
  test('states its limits on the form rather than at the point of failure', async () => {
    const html = String(
      await InvitePage({
        user: base.user,
        inviteUrl: base.inviteUrl,
        invited: [],
        dailyLimit: 10,
        maxPerSubmission: 5,
      }).toString(),
    );
    expect(html).toContain('5 addresses at a time');
    expect(html).toContain('10 a day');
    expect(html).toContain(base.inviteUrl);
  });

  test('offers no form at all when there is no mailer behind it', async () => {
    const html = String(
      await InvitePage({
        user: base.user,
        inviteUrl: base.inviteUrl,
        dailyLimit: 10,
        maxPerSubmission: 5,
        mailEnabled: false,
      }).toString(),
    );
    expect(html).not.toContain('action="/api/invite/email"');
    expect(html).toContain(base.inviteUrl);
  });
});
