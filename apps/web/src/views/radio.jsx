import { assetUrl } from '../lib/asset-version.js';
import { Layout } from './Layout.jsx';

/*
 * A reader's own SiriusXM, on the page -- and, since the line can be opened to
 * others, somebody else's.
 *
 * The radio counterpart of the "On your line" rail: the reader connects their
 * subscription once in settings, and the sports and news lineups play here
 * through a proxy that holds their session. The markup follows the channel rows
 * exactly -- a list, a name, a state span that ships empty, an actions span --
 * so the same stylesheet and the same habits carry over. What differs is that
 * there is no VLC link and no .m3u: both would hand over a SiriusXM address that
 * only works with the bearer, and the bearer never leaves the server.
 *
 * A shared line is the same page with a different play address: every row points
 * at /radio/shared/<owner>/stream.m3u8 instead of /radio/stream.m3u8, and the
 * server decides on every request whether this listener may use that line.
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

/** Where a row plays from: the reader's own line, unless told otherwise. */
const OWN_PLAY_BASE = '/radio/stream.m3u8';

/**
 * One channel. Play is disabled in the markup for the same reason the channel
 * rows are: a browser with no Media Source cannot play these, and app.js is
 * what knows. The station id rides on the button; quality is added client-side
 * from the reader's choice.
 */
export const RadioChannelRow = ({ ch, playBase = OWN_PLAY_BASE }) => (
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
        data-radio-play={`${playBase}?id=${encodeURIComponent(ch.stationId)}`}
        data-title={ch.title}
        data-artwork={ch.image ?? ''}
      >
        Play here
      </button>
    </span>
  </li>
);

/** The rows alone, for the fragment route that fills an event page in place. */
export const RadioRows = ({ channels, playBase = OWN_PLAY_BASE }) => (
  <ul class="own-channels radio-channels">
    {channels.map((ch) => (
      <RadioChannelRow ch={ch} playBase={playBase} />
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
 * The lines open to this reader, as a row of links. Drawn on the lineup page
 * whether or not the reader has a line of their own, because "also open to
 * you" is worth knowing either way; the one in use is marked.
 */
const SharedLines = ({ owners, via }) =>
  owners.length === 0 ? null : (
    <p class="muted small radio-shared-lines">
      Open to you:{' '}
      {owners.map((o, i) => (
        <>
          {i > 0 ? ', ' : ''}
          <a
            href={`/radio?via=${encodeURIComponent(o.owner_id)}`}
            class={via && via.owner_id === o.owner_id ? 'active' : ''}
            aria-current={via && via.owner_id === o.owner_id ? 'true' : undefined}
          >
            {o.label}
          </a>
        </>
      ))}
      .
    </p>
  );

/**
 * The lineup page. Two tabs and a search, both plain GET so the page works
 * before app.js does; the player is the only thing that needs a script.
 *
 * Three ways in: the reader's own line, somebody else's line they were given
 * (`via`), or neither -- in which case the page asks them to connect one.
 */
export const RadioPage = ({
  user,
  session,
  cat = 'sports',
  q = '',
  channels = [],
  error = null,
  sharedOwners = [],
  via = null,
}) => {
  const own = Boolean(session && !session.unreadable);
  const playBase = via
    ? `/radio/shared/${encodeURIComponent(via.owner_id)}/stream.m3u8`
    : OWN_PLAY_BASE;
  const viaQuery = via ? `&via=${encodeURIComponent(via.owner_id)}` : '';
  return (
    <Layout title="Radio" user={user} canonical="/radio">
      <h1>Radio</h1>
      {!user ? (
        <>
          <p class="muted">
            Have SiriusXM? Sign in, connect your subscription once, and every sports and news
            channel plays here — in the browser, on a TV box, wherever you are watching the game.
          </p>
          <p>
            <a class="cta" rel="nofollow" href="/login?next=%2Fradio">
              Sign in
            </a>
          </p>
        </>
      ) : !own && !via ? (
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
          {via ? (
            <p class="muted small">
              Listening through <strong>{via.label}</strong>'s SiriusXM. The audio comes to you
              through us; their sign-in stays with them.{' '}
              {own ? (
                <a href="/radio">Back to your own line</a>
              ) : (
                <a href="/settings#siriusxm">Connect your own</a>
              )}
              .
            </p>
          ) : (
            <p class="muted small">
              Playing as {session.email ?? 'your SiriusXM account'}. These are SiriusXM's streams,
              passed through to your own browser and nobody else's.{' '}
              <a href="/settings#siriusxm">Manage the connection</a>.
            </p>
          )}
          <SharedLines owners={sharedOwners} via={via} />

          <div class="radio-toolbar">
            <nav class="radio-tabs" aria-label="Lineup">
              <a
                href={`/radio?cat=sports${viaQuery}`}
                class={cat === 'sports' && !q ? 'active' : ''}
              >
                Sports
              </a>
              <a href={`/radio?cat=news${viaQuery}`} class={cat === 'news' && !q ? 'active' : ''}>
                News
              </a>
            </nav>
            <form method="get" action="/radio" class="radio-search">
              {via ? <input type="hidden" name="via" value={via.owner_id} /> : null}
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
            <RadioRows channels={channels} playBase={playBase} />
          )}
        </section>
      )}
    </Layout>
  );
};

/**
 * A fixture's or a team's own broadcasts, on SiriusXM.
 *
 * Drawn for a connected reader on a league SiriusXM carries by team, and
 * filled in by app.js the moment the page is up: `data-radio-find` is the
 * fragment route, and nothing upstream is asked at render, so the fixture page
 * stays as fast as it was. The rows arrive as HTML from the same component the
 * lineup page uses, so there is one row template and it is on the server.
 *
 * Drawn as well for a reader with no line of their own when somebody has opened
 * theirs to them: `via` names whose, and the find address carries it.
 *
 * @param {{find: string, sides: string[], via?: string|null}} props what to look up, who for, and whose line
 */
export const RadioTeamSection = ({ find, sides, via = null }) => (
  <section class="own-line radio-line" {...radioAssets()} data-radio-find={find}>
    <h2>On SiriusXM</h2>
    <p class="muted small">
      {sides.length === 1
        ? `${sides[0]}'s own broadcast, when SiriusXM is carrying it. `
        : `Each side's own broadcast, when SiriusXM is carrying it. `}
      Team feeds appear close to kickoff and go away after the final whistle.{' '}
      {via
        ? `These play through ${via}'s subscription, which they opened to you.`
        : 'These play on your subscription, here and nowhere else.'}
    </p>
    <div data-radio-results>
      <p class="muted small radio-looking">Looking on SiriusXM…</p>
    </div>
  </section>
);

/**
 * The answer, per side. A side with nothing is said so, in words, because
 * "no feed yet" and "the lookup broke" must never look the same; a side whose
 * lookup failed says what SiriusXM said.
 */
export const RadioSidesFragment = ({ sides, playBase = OWN_PLAY_BASE }) => (
  <>
    {sides.map((side) => (
      <div class="radio-side">
        <h3 class="card-title">{side.team}</h3>
        {side.error ? (
          <p class="feedback error">{side.error}</p>
        ) : side.stations.length === 0 ? (
          <p class="muted small">No {side.team} feed on SiriusXM right now.</p>
        ) : (
          <RadioRows channels={side.stations} playBase={playBase} />
        )}
      </div>
    ))}
  </>
);

/**
 * Who may listen through this line. The same card, the same three audiences
 * and the same people picker as the playlist's, because a reader who has set
 * one up should recognise the other. One difference, and the copy says it:
 * nothing anybody gets here is the credential.
 */
const RadioSharing = ({ session, member, shareCandidates }) => (
  <div class="card" id="radio-sharing">
    <div class="card-head">
      <h3 class="card-title">Who can listen through your line</h3>
      <p class="card-desc">
        Whoever you choose can play the sports and news channels, and a game's own broadcast, on
        your SiriusXM. They never get your sign-in: the audio comes to them through us, and everyone
        on a channel shares one connection, so SiriusXM sees your line once per channel no matter
        how many are listening.
      </p>
    </div>
    <form method="post" action="/api/radio/share">
      <label class="field">
        <span>Audience</span>
        <select name="audience">
          <option value="none" selected={session.shareAudience === 'none'}>
            Nobody — keep it private
          </option>
          <option value="friends" selected={session.shareAudience === 'friends'}>
            Only the people I name{member ? '' : ' (premium)'}
          </option>
          <option value="everyone" selected={session.shareAudience === 'everyone'}>
            Everyone signed in
          </option>
        </select>
        {member ? null : (
          <span class="hint">
            Naming individual people is part of <a href="/premium">premium</a>. Private and everyone
            are free.
          </span>
        )}
      </label>

      <label class="field">
        <span>What to call it (optional)</span>
        <input
          type="text"
          name="label"
          maxlength="80"
          value={session.sharedLabel ?? ''}
          placeholder="Anthony's SiriusXM"
          autocomplete="off"
        />
        {/* The email on the account is the one thing not to publish. */}
        <span class="hint">Shown instead of your SiriusXM email.</span>
      </label>

      <button class="cta" type="submit">
        Save
      </button>
    </form>

    {session.shareAudience === 'friends' ? (
      <div class="share-grants">
        <h4>Named people</h4>
        {shareCandidates.length === 0 ? (
          <p class="empty">Nobody to name yet. This lists people you follow who follow you back.</p>
        ) : (
          <ul class="grant-list">
            {shareCandidates.map((p) => (
              <li>
                <span>{p.display_name ?? (p.handle ? `@${p.handle}` : 'Someone')}</span>
                <form method="post" action="/api/radio/share/grant" class="inline">
                  <input type="hidden" name="user_id" value={p.id} />
                  <input type="hidden" name="allowed" value={p.granted ? '0' : '1'} />
                  <button class={p.granted ? 'ghost small-btn' : 'small-btn'} type="submit">
                    {p.granted ? 'Remove' : 'Add'}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : null}
  </div>
);

/**
 * The settings section. Three states, one form each: not connected (ask for
 * the email), waiting for the code (ask for the code), connected (offer to
 * disconnect, and to share). All plain POSTs, so it works with JavaScript off
 * like the rest of the page.
 */
export const RadioSettings = ({
  session,
  pending,
  notice,
  error,
  member = false,
  shareCandidates = [],
}) => (
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
      <>
        <div class="card">
          <div class="card-head">
            <h3 class="card-title">Connected</h3>
            <p class="card-desc">{session.email ?? 'SiriusXM account'}</p>
          </div>
          <p class="muted small">
            Your session is stored encrypted and renewed automatically. Disconnecting deletes it
            here; it does not sign you out of SiriusXM anywhere else.
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
        <RadioSharing session={session} member={member} shareCandidates={shareCandidates} />
      </>
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
        <p class="muted small">
          Enter the email on your SiriusXM account. We'll send you a sign-in code.
        </p>
        <label class="field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            required
            placeholder="you@example.com"
            autocomplete="email"
            autofocus
          />
        </label>
        <button class="cta" type="submit">
          Send sign-in code
        </button>
      </form>
    )}
  </section>
);
