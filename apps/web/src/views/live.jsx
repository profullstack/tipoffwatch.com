import { brand } from '@tipoff/config';
import { CheckoutForm } from './checkout.jsx';
import { LocalTime } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * Live TV passes: the page that sells one, and the card that points at it.
 *
 * Two rules. Every figure here is passed in from configuration or a query --
 * there is no "$1" in the markup, for the reason premium.jsx gives. And the
 * provider is never named: the reader buys live TV from us, plays it here, and
 * what we buy it from is our business. Nothing on this page, in the settings
 * card or on a channel row says who that is.
 */

const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format((cents ?? 0) / 100);

const termWord = { week: 'a week', month: 'a month', year: 'a year' };
const planTitle = { week: 'Week', month: 'Month', year: 'Year', gift: 'Code or invite' };

/** The cheapest way in, for a card that has one line to say it. */
export const fromPrice = (plans) => {
  const cheapest = [...plans].sort((a, b) => a.priceCents / a.days - b.priceCents / b.days)[0];
  const weekly = plans.find((p) => p.key === 'week') ?? cheapest;
  return weekly ? `${money(weekly.priceCents, weekly.currency)} ${termWord[weekly.key]}` : null;
};

/**
 * The card an event page shows a reader with no list: what a pass is, what it
 * costs, and one button. `eventId` sends them back to this game once paid.
 */
export const LiveUpsell = ({ plans, eventId = null, connections = 1, signedIn = false }) => {
  if (!plans?.length) return null;
  const back = eventId ? `?event=${eventId}` : '';
  return (
    <div class="card live-upsell">
      <div class="card-head">
        <h3 class="card-title">Watch it live here</h3>
        <p class="card-desc">
          Live sport in your browser, on this page, from {fromPrice(plans)}. No app, no setup: buy a
          pass and the channels carrying each game appear on its page
          {connections > 1 ? `, up to ${connections} at once in Multiview` : ''}.
        </p>
      </div>
      <div class="card-actions">
        <a class="cta" href={`/live${back}`}>
          {signedIn ? 'Get a pass' : 'See the passes'}
        </a>
      </div>
    </div>
  );
};

export const LivePage = ({
  user,
  plans = [],
  pass = null,
  managed = false,
  hasOwnList = false,
  history = [],
  connections = 1,
  paymentsEnabled = true,
  checkout = null,
  enabled = true,
  notice = null,
  error = null,
}) => {
  return (
    <Layout
      title="Live TV"
      user={user}
      description={`Watch live sport in your browser on ${brand.name}, from ${fromPrice(plans) ?? 'a dollar a week'}.`}
    >
      <div class="page-head">
        <h1>Live TV</h1>
        {pass ? (
          <span class="pill">
            Pass until <LocalTime at={pass.expires_at} />
          </span>
        ) : null}
      </div>

      {notice ? <p class="feedback ok">{notice}</p> : null}
      {error ? <p class="feedback error">{error}</p> : null}

      <p class="lead">
        Live sport, played right here on the game page. Open a game, press Play, and it is on -- in
        the browser you are already in, on a phone, a laptop or a TV box. Nothing to install and
        nothing to configure
        {connections > 1 ? `; up to ${connections} channels at once in Multiview` : ''}.
      </p>

      {!enabled ? (
        <p class="empty">Passes are not on sale right now.</p>
      ) : !paymentsEnabled ? (
        <p class="empty">Payments are not switched on here.</p>
      ) : null}

      {enabled && paymentsEnabled && checkout ? (
        <section class="plans">
          {/* The three passes as one form: pick one, one button. Signed out, the
              button reads "Sign in to buy" and the post goes to sign in and back. */}
          <CheckoutForm html={checkout} />
        </section>
      ) : null}

      {user && pass ? (
        <section>
          <h2>Your channels</h2>
          {managed ? (
            <p class="ok">
              Your channels are set up. Open any game and look for <strong>On your line</strong>;
              the entries there play with the Play button, and several at once in{' '}
              <a href="/multiview">Multiview</a>.
            </p>
          ) : hasOwnList ? (
            <>
              <p class="muted">
                You have a list of your own in <a href="/settings">settings</a>, so your pass is not
                in use. Switch to ours whenever you like; your own address is kept and given back
                when the pass ends.
              </p>
              <form method="post" action="/api/live/use">
                <button class="ghost" type="submit">
                  Use the pass instead of my list
                </button>
              </form>
            </>
          ) : (
            <>
              <p class="feedback error">
                Your channels are not set up yet. This usually finishes on its own within a minute
                of payment; if it has not, press the button.
              </p>
              <form method="post" action="/api/live/use">
                <button class="cta" type="submit">
                  Set up my channels
                </button>
              </form>
            </>
          )}
        </section>
      ) : null}

      {user && history.length > 0 ? (
        <section>
          <h2>Receipts</h2>
          <ul class="ledger">
            {history.map((h) => (
              <li>
                <span>
                  {planTitle[h.plan] ?? h.plan} · <LocalTime at={h.started_at} /> to{' '}
                  <LocalTime at={h.expires_at} />
                </span>
                <span class="mono">{money(h.price_cents, h.currency)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2>The small print</h2>
        <ul class="muted small">
          <li>
            A pass plays on this site, to your own signed-in session. It cannot be exported to
            another player or shared with another account.
          </li>
          <li>
            Channels are checked before they are offered. A slot listed by a provider can still be
            empty for a given game; when it is, the page says so rather than playing nothing.
          </li>
          <li>A pass is not refundable once it has started.</li>
        </ul>
      </section>
    </Layout>
  );
};
