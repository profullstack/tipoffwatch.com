import { createCheckout, ERRORS } from '@profullstack/checkout';
import { assets } from '@profullstack/checkout/assets';
import { brand, config } from '@tipoff/config';
import * as live from '@tipoff/live';
import { MEMBERSHIP_KIND } from '@tipoff/payments/membership';

/**
 * The checkout form (@profullstack/checkout) on /premium and /live.
 *
 * The form only decides what the buyer sees and which option they picked. What
 * is charged, and what the webhook is told, is decided by the two functions at
 * the top of this file, and BOTH ways of buying go through them: the form's
 * pay() and the JSON routes (POST /api/membership/buy, POST /api/live/buy). One
 * place builds a session, so the page cannot open a different one from the API.
 *
 * Nothing here reads who is paying from the request. The routes hand in the
 * session's user.
 */

/* ------------------------------------------------------ what is charged -- */

/**
 * The CoinPay session for a premium term, as pay.createCheckout takes it.
 *
 * `kind` is what the webhook branches on, and it is the only thing that makes
 * this payment a membership rather than a seat at a fixture. A checkout that
 * omitted it would settle, be recorded, and grant nothing at all.
 */
export function membershipCharge(user) {
  return {
    user,
    // CoinPay files every session under who paid; the hosted page offers every coin + PayPal.
    email: user.email,
    accountId: String(user.id),
    amountCents: config.membership.priceCents,
    currency: config.membership.currency,
    description: `${brand.name} premium, ${config.membership.termDays} days`,
    metadata: { kind: MEMBERSHIP_KIND },
    successUrl: `${config.siteUrl}/premium?paid=1`,
    cancelUrl: `${config.siteUrl}/premium`,
  };
}

/** A game id from a link or a form, or null. Only ever a positive integer. */
export function eventIdOf(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The CoinPay session for a live TV pass. `plan` is one of live.plansForSale();
 * it travels in the metadata because the settled payload carries no product of
 * its own, and the webhook needs to know how long a term it is granting.
 * `eventId` is the game the buyer came from, and where they are sent back to.
 */
export function livePassCharge(user, plan, eventId = null) {
  const back = eventId ? `/events/${eventId}` : '/live';
  return {
    user,
    // CoinPay files every session under who paid; the hosted page offers every coin + PayPal.
    email: user.email,
    accountId: String(user.id),
    amountCents: plan.priceCents,
    currency: plan.currency,
    // What the buyer reads at checkout. "Live TV", never the provider.
    description: `${brand.name} Live TV, ${plan.days} days`,
    metadata: { kind: live.LIVE_PASS_KIND, plan: plan.key },
    successUrl: `${config.siteUrl}/live?paid=1${eventId ? `&event=${eventId}` : ''}`,
    cancelUrl: `${config.siteUrl}${back}`,
  };
}

/* ------------------------------------------------------- what is shown -- */

const usd = (cents, currency) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);

/** 365 days is "A year" and 30 is "A month"; anything else is said in days. */
const termName = (days) => (days === 365 ? 'A year' : days === 30 ? 'A month' : `${days} days`);

/** The one premium term, priced from configuration. */
export function membershipOptions() {
  const { priceCents, termDays } = config.membership;
  const name = termName(termDays);
  return [
    {
      id: 'premium',
      name,
      detail: name === `${termDays} days` ? '' : `${termDays} days`,
      price: priceCents / 100,
    },
  ];
}

const PASS_NAME = { week: 'Week', month: 'Month', year: 'Year' };

/**
 * The three passes, each paid once for its number of days. They are prepaid
 * terms of different lengths, not a monthly plan, so no saving is computed. The
 * year says what a month works out to because the site already sells it that
 * way; it is the one the page has always marked out, so it is the one selected.
 */
export function livePassOptions() {
  return live.plansForSale().map((plan) => ({
    id: plan.key,
    name: PASS_NAME[plan.key] ?? plan.key,
    detail: plan.perMonthCents
      ? `${plan.days} days, ${usd(plan.perMonthCents, plan.currency)} a month`
      : `${plan.days} days`,
    price: plan.priceCents / 100,
    default: plan.key === 'year',
  }));
}

/** The amount the form showed is the amount charged, or nothing is opened. */
function sameAmount(order, charge) {
  if (charge.amountCents !== order.totalCents || charge.currency !== order.currency) {
    throw new Error(
      `checkout amount changed: the form showed ${order.totalCents} ${order.currency}, the charge is ${charge.amountCents} ${charge.currency}`,
    );
  }
  return charge;
}

const opened = ({ checkoutUrl, paymentRef }) => ({ url: checkoutUrl, id: paymentRef });

/** What both forms share: this site, its one dark theme, and an account from the session. */
const common = (user) => ({
  site: brand.domain,
  siteUrl: config.siteUrl,
  theme: 'dark',
  requireAccount: true,
  account: () => (user ? { id: String(user.id), email: user.email ?? '' } : null),
});

/**
 * The premium form, for one request.
 *
 * @param {object} args
 * @param {object|null} args.user  the session's user, never anything from the request
 * @param {boolean} [args.renewing]  they hold a membership already
 * @param {(charge: object) => Promise<{checkoutUrl: string, paymentRef?: string}>} args.start  pay.createCheckout
 */
export function membershipCheckout({ user, renewing = false, start }) {
  return createCheckout({
    ...common(user),
    currency: config.membership.currency,
    title: renewing ? 'Renew' : 'Join',
    optionsLabel: 'Membership',
    action: '/checkout/premium',
    page: '/premium',
    options: membershipOptions(),
    cta: user ? 'Continue to payment' : 'Sign in to join',
    processor:
      'Paid through CoinPay in any major coin or PayPal. It does not renew itself: there is nothing to cancel and no card on file.',
    signIn: '/login',
    pay: async (order) => {
      if (!user) throw new Error('checkout needs a signed-in user');
      return opened(await start(sameAmount(order, membershipCharge(user))));
    },
  });
}

/**
 * The live TV pass form, for one request.
 *
 * @param {object} args
 * @param {object|null} args.user  the session's user
 * @param {number|null} [args.eventId]  the game they came from (from the page's own link)
 * @param {boolean} [args.adding]  they hold a pass already
 * @param {(charge: object) => Promise<{checkoutUrl: string, paymentRef?: string}>} args.start  pay.createCheckout
 */
export function livePassCheckout({ user, eventId = null, adding = false, start }) {
  const back = eventId ? `?event=${eventId}` : '';
  return createCheckout({
    ...common(user),
    currency: config.live.currency,
    title: adding ? 'Add time' : 'Pick a pass',
    subtitle: adding
      ? 'Time you buy is added to the end of what you hold, so buying early costs you nothing.'
      : '',
    optionsLabel: 'Pass',
    action: `/checkout/live${back}`,
    page: '/live',
    options: livePassOptions(),
    cta: user ? 'Continue to payment' : 'Sign in to buy',
    processor: `Paid through the same checkout as ${brand.copy.premiumTitle}: any major coin or PayPal. Access begins the moment the payment settles, usually within a few minutes.`,
    // Back to this page with the pass they picked, and the game they came from.
    signIn: (next) => {
      const path = eventId ? `${next}${next.includes('?') ? '&' : '?'}event=${eventId}` : next;
      return `/login?next=${encodeURIComponent(path)}`;
    },
    pay: async (order) => {
      if (!user) throw new Error('checkout needs a signed-in user');
      const plan = live.planFor(order.option.id);
      if (!plan) throw new Error(`no such pass: ${order.option.id}`);
      return opened(await start(sameAmount(order, livePassCharge(user, plan, eventId))));
    },
  });
}

/**
 * The form's markup for a page that already has its own <h1>: the package heads
 * a checkout page with one, and here the form is a section of a longer page.
 */
export function formHtml(checkout, { query, user }) {
  return checkout
    .html({ query, account: user ? { email: user.email ?? '' } : null })
    .replace('<h1 class="pfc-title">', '<h2 class="pfc-title">')
    .replace('</h1>', '</h2>');
}

/**
 * A failed form post comes back as ?error=<code>, and the form prints the
 * message for it. /premium and /live also print ?error= themselves, as free
 * text from their other forms; this keeps a bare code out of that line.
 */
export const pageError = (value) => (value && !Object.hasOwn(ERRORS, value) ? value : null);

/* ----------------------------------------------------------- the assets -- */

/*
 * The package's stylesheet and its single-file browser script, served from our
 * own origin: the policy allows no inline script or style and no other host for
 * these. The form sells without the script; with it the total follows the choice.
 */
const files = assets();

export const CHECKOUT_ASSETS = {
  css: {
    path: '/vendor-checkout.css',
    href: `/vendor-checkout.css?v=${files.css.hash}`,
    ...files.css,
  },
  js: { path: '/vendor-checkout.js', href: `/vendor-checkout.js?v=${files.js.hash}`, ...files.js },
};
