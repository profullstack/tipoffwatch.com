import { assetUrl } from '../lib/asset-version.js';
import { Layout } from './Layout.jsx';

/*
 * A reader's own SiriusXM, on the page.
 *
 * The radio counterpart of the "On your line" rail: the reader connects their
 * subscription once in settings, and the sports and news lineups play here
 * through a proxy that holds their session. The markup follows the channel rows
 * exactly -- a list, a name, a state span that ships empty, an actions span --
 * so the same stylesheet and the same habits carry over. What differs is that
 * there is no VLC link and no .m3u: both would hand over a SiriusXM address that
 * only works with the bearer, and the bearer never leaves the server.
 */

/**
 * The bundle attributes a radio section carries, so app.js can fetch the
 * player on the first press of Play and not before. Versioned here because only
 * the server knows the hash.
 */
export const radioAssets = () => ({
  'data-radio-src': assetUrl('vendor-player.js'),
  'data-radio-css': assetUrl('vendor-player.css'),
});

/**
 * One channel. Play is disabled in the markup for the same reason the channel
 * rows are: a browser with no Media Source cannot play these, and app.js is
 * what knows. The station id rides on the button; quality is added client-side
 * from the reader's choice.
 */
export const RadioChannelRow = ({ ch }) => (
  <li class="radio-channel" data-station={ch.stationId}>
    {ch.image ? (
      <img class="radio-art" src={ch.image} alt="" width="48" height="48" loading="lazy" />
    ) : (
      <span class="radio-art radio-art-empty" aria-hidden="true" />
    )}
    <span class="own-channel-name">
      {ch.number ? <span class="radio-number">Ch {ch.number}</span> : null}
      {ch.title}
      {ch.description ? <span class="radio-desc muted small">{ch.description}</span> : null}
    </span>
    <span class="own-channel-state" />
    <span class="own-channel-actions">
      <button
        type="button"
        class="ghost small-btn play-btn"
        disabled
        data-radio-play={`/radio/stream.m3u8?id=${encodeURIComponent(ch.stationId)}`}
        data-title={ch.title}
        data-artwork={ch.image ?? ''}
      >
        Play here
      </button>
    </span>
  </li>
);

/** The rows alone, for the fragment route that fills an event page in place. */
export const RadioRows = ({ channels }) => (
  <ul class="own-channels radio-channels">
    {channels.map((ch) => (
      <RadioChannelRow ch={ch} />
    ))}
  </ul>
);

const QUALITIES = [
  ['256', '256 kbps'],
  ['128', '128 kbps'],
  ['64', '64 kbps'],
  ['32', '32 kbps'],
];

/**
 * The lineup page. Two tabs and a search, both plain GET so the page works
 * before app.js does; the player is the only thing that needs a script.
 */
export const RadioPage = ({
  user,
  session,
  cat = 'sports',
  q = '',
  channels = [],
  error = null,
}) => (
  <Layout title="Radio" user={user} canonical="/radio">
    <h1>Radio</h1>
    {!user ? (
      <>
        <p class="muted">
          Have SiriusXM? Sign in, connect your subscription once, and every sports and news channel
          plays here — in the browser, on a TV box, wherever you are watching the game.
        </p>
        <p>
          <a class="cta" rel="nofollow" href="/login?next=%2Fradio">
            Sign in
          </a>
        </p>
      </>
    ) : !session || session.unreadable ? (
      <>
        <p class="muted">
          Connect your SiriusXM subscription and the sports and news channels play here. It takes
          the email on your account and the code SiriusXM sends to it — no password.
        </p>
        <p>
          <a class="cta" href="/settings#siriusxm">
            Connect SiriusXM
          </a>
        </p>
      </>
    ) : (
      <section class="own-line radio-line" {...radioAssets()}>
        <p class="muted small">
          Playing as {session.email ?? 'your SiriusXM account'}. These are SiriusXM's streams,
          passed through to your own browser and nobody else's.{' '}
          <a href="/settings#siriusxm">Manage the connection</a>.
        </p>

        <div class="radio-toolbar">
          <nav class="radio-tabs" aria-label="Lineup">
            <a href="/radio?cat=sports" class={cat === 'sports' && !q ? 'active' : ''}>
              Sports
            </a>
            <a href="/radio?cat=news" class={cat === 'news' && !q ? 'active' : ''}>
              News
            </a>
          </nav>
          <form method="get" action="/radio" class="radio-search">
            <label class="sr-only" for="radio-q">
              Search channels
            </label>
            <input
              id="radio-q"
              type="search"
              name="q"
              value={q}
              placeholder="Search channels, e.g. ESPN"
              autocomplete="off"
              enterkeyhint="search"
            />
            <button type="submit" class="ghost">
              Go
            </button>
          </form>
          <label class="radio-quality">
            <span class="muted small">Quality</span>
            <select data-radio-quality aria-label="Stream quality">
              {QUALITIES.map(([v, label]) => (
                <option value={v}>{label}</option>
              ))}
            </select>
          </label>
        </div>

        {error ? <p class="feedback error">{error}</p> : null}

        {channels.length === 0 && !error ? (
          <p class="empty muted">
            {q
              ? `Nothing on SiriusXM matches “${q}”.`
              : 'No channels came back. Try again in a moment.'}
          </p>
        ) : (
          <RadioRows channels={channels} />
        )}
      </section>
    )}
  </Layout>
);

/**
 * The event page's slice of this: the channels that name either side.
 *
 * Nothing is fetched at render. Searching SiriusXM is an upstream call on the
 * reader's own session, and an event page is opened far more often than a
 * reader wants radio for it -- so the section offers a button, and app.js asks
 * `/radio/find` only when it is pressed. Rendered only for a connected reader,
 * like the playlist rail above it.
 */
export const RadioEventSection = ({ event }) => (
  <section
    class="own-line radio-line"
    {...radioAssets()}
    data-radio-find={`/radio/find?event=${event.id}`}
  >
    <h2>On SiriusXM</h2>
    <p class="muted small">
      SiriusXM carries most major-league games on a channel of their own. Look one up for this
      fixture and it plays here, on your subscription.
    </p>
    <p>
      <button type="button" class="ghost small-btn" data-radio-find-button>
        Find this game on SiriusXM
      </button>
    </p>
    <div data-radio-results />
  </section>
);

/**
 * The settings section. Three states, one form each: not connected (ask for
 * the email), waiting for the code (ask for the code), connected (offer to
 * disconnect). All plain POSTs, so it works with JavaScript off like the rest
 * of the page.
 */
export const RadioSettings = ({ session, pending, notice, error }) => (
  <section id="siriusxm">
    <h2>SiriusXM</h2>
    <p class="muted small">
      If you subscribe to SiriusXM, connect it here and the sports and news channels play on this
      site — on the <a href="/radio">Radio</a> page, and on a game's page when SiriusXM is carrying
      it. We sign in the way the SiriusXM app does: the email on your account, and the code they
      send to it. No password is asked for or stored.
    </p>

    {error ? <p class="feedback error">{error}</p> : null}
    {notice ? <p class="feedback ok">{notice}</p> : null}

    {session && !session.unreadable ? (
      <div class="card">
        <div class="card-head">
          <h3 class="card-title">Connected</h3>
          <p class="card-desc">{session.email ?? 'SiriusXM account'}</p>
        </div>
        <p class="muted small">
          Your session is stored encrypted and renewed automatically. Disconnecting deletes it here;
          it does not sign you out of SiriusXM anywhere else.
        </p>
        <div class="card-actions">
          <a class="cta small-btn" href="/radio">
            Open Radio
          </a>
          <form method="post" action="/api/radio/disconnect" class="inline">
            <button class="ghost small-btn danger" type="submit">
              Disconnect
            </button>
          </form>
        </div>
      </div>
    ) : pending ? (
      <form method="post" action="/api/radio/connect/verify" class="card">
        <h3 class="card-title">Enter the code</h3>
        <p class="muted small">
          Check <strong>{pending.email}</strong> for a sign-in code from SiriusXM. It is good for
          about ten minutes.
        </p>
        <label class="field">
          <span>Sign-in code</span>
          <input
            type="text"
            name="otp"
            inputmode="numeric"
            autocomplete="one-time-code"
            placeholder="000000"
            required
            autofocus
            class="input mono radio-otp"
          />
        </label>
        <div class="card-actions">
          <button class="cta" type="submit">
            Verify
          </button>
          <button class="ghost small-btn" type="submit" formaction="/api/radio/connect/cancel">
            Start over
          </button>
        </div>
      </form>
    ) : (
      <form method="post" action="/api/radio/connect" class="card">
        <h3 class="card-title">Connect your SiriusXM account</h3>
        {session?.unreadable ? (
          <p class="feedback error">
            Your stored session can no longer be decrypted, so it has to be connected again.
          </p>
        ) : null}
        <label class="field">
          <span>Email on your SiriusXM account</span>
          <input
            type="email"
            name="email"
            required
            placeholder="you@example.com"
            autocomplete="email"
          />
        </label>
        <button class="cta" type="submit">
          Send sign-in code
        </button>
      </form>
    )}
  </section>
);
