import { Layout } from './Layout.jsx';
import { EventList } from './components.jsx';

export const Landing = ({ user, today, tz, vapidKey }) => (
  <Layout title={null} user={user} vapidKey={vapidKey} canonical="/">
    <section class="hero">
      <h1>Never miss a game.</h1>
      <p>
        Follow any team in the world — 354 leagues across 17 sports — and get a web
        notification and an email an hour before kickoff, and again one minute out.
      </p>
      <p class="hero-actions">
        {user ? (
          <a class="cta" href="/sports">Add teams</a>
        ) : (
          <a class="cta" href="/signup">Start following — it's free</a>
        )}
        <a class="ghost" href="/sports">Browse today's games</a>
      </p>
      <p class="muted small">Free forever. No app to install — add it to your home screen.</p>
    </section>

    <section>
      <h2>Today</h2>
      <EventList events={today} tz={tz} user={user} emptyText="No games scheduled today." />
    </section>
  </Layout>
);

export const SportsIndex = ({ user, sports, leagues }) => (
  <Layout title="Sports" user={user} canonical="/sports">
    <h1>Sports</h1>
    <p class="muted">Pick a competition, then follow the teams you care about.</p>
    <ul class="sports">
      {sports.map((s) => (
        <li>
          <a href={`/sports/${s.sport}`}>
            <strong>{s.sport.replace(/-/g, ' ')}</strong>
            <span class="muted">{s.leagues} leagues</span>
          </a>
        </li>
      ))}
    </ul>

    <h2>Popular right now</h2>
    <ul class="leagues">
      {leagues.map((l) => (
        <li>
          <a href={`/leagues/${l.slug}`}>{l.name}</a>
        </li>
      ))}
    </ul>
  </Layout>
);

export const SportPage = ({ user, sport, leagues }) => (
  <Layout title={sport} user={user} canonical={`/sports/${sport}`}>
    <h1>{sport.replace(/-/g, ' ')}</h1>
    <ul class="leagues">
      {leagues.map((l) => (
        <li>
          <a href={`/leagues/${l.slug}`}>{l.name}</a>
          {user ? (
            <form method="post" action="/api/follow" class="inline">
              <input type="hidden" name="subject_type" value="league" />
              <input type="hidden" name="subject_id" value={l.id} />
              <input type="hidden" name="next" value={`/sports/${sport}`} />
              <button type="submit">Follow league</button>
            </form>
          ) : null}
        </li>
      ))}
    </ul>
  </Layout>
);

export const LeaguePage = ({ user, league, events, tz }) => (
  <Layout title={league.name} user={user} canonical={`/leagues/${league.slug}`}>
    <h1>{league.name}</h1>
    {user ? (
      <form method="post" action="/api/follow" class="inline">
        <input type="hidden" name="subject_type" value="league" />
        <input type="hidden" name="subject_id" value={league.id} />
        <input type="hidden" name="next" value={`/leagues/${league.slug}`} />
        <button class="cta" type="submit">Follow every game in this league</button>
      </form>
    ) : (
      <p><a href="/login">Sign in</a> to follow this league.</p>
    )}
    <EventList events={events} tz={tz} user={user} emptyText="No fixtures in the next two weeks." />
  </Layout>
);

export const Following = ({ user, events, follows, tz, vapidKey }) => (
  <Layout title="My games" user={user} vapidKey={vapidKey}>
    <h1>My games</h1>

    {/* Rendered server-side but only meaningful with JS; hidden until the script
        confirms the browser actually supports push. */}
    <div id="push-optin" hidden class="notice">
      <p>Get a notification an hour before kickoff, and one minute out.</p>
      <button type="button" id="enable-push">Turn on notifications</button>
    </div>

    {follows.length === 0 ? (
      <p class="empty">
        You're not following anything yet. <a href="/sports">Find your teams</a>.
      </p>
    ) : (
      <ul class="chips">
        {follows.map((f) => (
          <li class="chip">
            {f.label}
            <form method="post" action="/api/unfollow" class="inline">
              <input type="hidden" name="subject_type" value={f.subject_type} />
              <input type="hidden" name="subject_id" value={f.subject_id} />
              <input type="hidden" name="next" value="/following" />
              <button type="submit" aria-label={`Unfollow ${f.label}`}>×</button>
            </form>
          </li>
        ))}
      </ul>
    )}

    <EventList events={events} tz={tz} user={user} emptyText="Nothing coming up for what you follow." />
  </Layout>
);

export const EventPage = ({ user, event, tz, offers, entitlement }) => (
  <Layout title={event.name} user={user} canonical={`/events/${event.id}`}>
    <h1>{event.away_name && event.home_name ? `${event.away_name} at ${event.home_name}` : event.name}</h1>
    <p class="muted">
      {event.league_name}
      {event.venue ? ` · ${event.venue}` : ''} ·{' '}
      {new Date(event.starts_at).toLocaleString('en-US', { timeZone: tz || 'UTC' })}
    </p>

    <section class="stream">
      <h2>Watch</h2>
      {entitlement ? (
        <p class="ok">
          You have access to this game. <a class="cta" href={`/events/${event.id}/watch`}>Open the stream</a>
        </p>
      ) : offers.length === 0 ? (
        <p class="muted">Nobody is sharing a stream for this game yet.</p>
      ) : (
        <ul class="offers">
          {offers.map((o) => (
            <li>
              <span>${(o.price_cents / 100).toFixed(2)}</span>
              <span class="muted">{o.remaining} left</span>
              <form method="post" action={`/api/events/${event.id}/buy`} class="inline">
                <input type="hidden" name="offer_id" value={o.id} />
                <button class="cta" type="submit" disabled={!user}>
                  {user ? 'Buy access' : 'Sign in to buy'}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  </Layout>
);

/**
 * One component behind both /login and /signup.
 *
 * They are the same mechanism -- a magic link both signs in and registers -- but a
 * site with no page called "sign up" reads to a new visitor as a site with no
 * accounts. Only the wording differs.
 */
export const SignIn = ({ mode, sent, next }) => (
  <Layout title={mode === 'signup' ? 'Create your account' : 'Sign in'}>
    <section class="auth">
      <h1>{mode === 'signup' ? 'Create your account' : 'Sign in'}</h1>
      {sent ? (
        <p class="ok">
          If that address can receive mail, a sign-in link is on its way. It works once
          and expires in 20 minutes.
        </p>
      ) : (
        <>
          <p class="muted">
            {mode === 'signup'
              ? 'Enter your email and we will send you a link. No password to choose.'
              : 'We will email you a link. No password to remember.'}
          </p>
          <form method="post" action="/api/auth/magic">
            <input type="hidden" name="next" value={next ?? '/following'} />
            <label>
              Email
              <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" />
            </label>
            <button class="cta" type="submit">Email me a link</button>
          </form>

          <div class="or">or</div>
          <button type="button" id="passkey-signin" class="ghost">Use a passkey</button>

          <p class="muted small">
            {mode === 'signup' ? (
              <>Already have an account? <a href="/login">Sign in</a> — same link either way.</>
            ) : (
              <>No account yet? <a href="/signup">Create one</a> — the link makes it for you.</>
            )}
          </p>
        </>
      )}
    </section>
  </Layout>
);

export const Settings = ({ user, prefs, passkeys }) => (
  <Layout title="Settings" user={user}>
    <h1>Settings</h1>

    <section>
      <h2>Reminders</h2>
      <form method="post" action="/api/prefs">
        <fieldset>
          <legend>When to tell you</legend>
          {[60, 30, 15, 5, 1].map((m) => (
            <label class="check">
              <input
                type="checkbox"
                name="offsets"
                value={m}
                checked={prefs.offsets_minutes.includes(m)}
              />
              {m >= 60 ? `${m / 60} hour before` : `${m} minute${m === 1 ? '' : 's'} before`}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>How</legend>
          {['webpush', 'email'].map((c) => (
            <label class="check">
              <input type="checkbox" name="channels" value={c} checked={prefs.channels.includes(c)} />
              {c === 'webpush' ? 'Web notification' : 'Email'}
            </label>
          ))}
        </fieldset>
        <button class="cta" type="submit">Save</button>
      </form>
    </section>

    <section>
      <h2>Passkeys</h2>
      {passkeys.length === 0 ? (
        <p class="muted">No passkeys yet. Add one to sign in without waiting for email.</p>
      ) : (
        <ul>{passkeys.map((p) => <li>Added {new Date(p.created_at).toLocaleDateString()}</li>)}</ul>
      )}
      <button type="button" id="add-passkey" class="ghost">Add a passkey</button>
    </section>

    <section>
      <h2>Account</h2>
      <p class="muted">{user.email}</p>
      <form method="post" action="/api/auth/logout">
        <button type="submit" class="ghost">Sign out</button>
      </form>
    </section>
  </Layout>
);

export const NotFound = ({ user }) => (
  <Layout title="Not found" user={user}>
    <h1>Not found</h1>
    <p><a href="/">Back to today's games</a></p>
  </Layout>
);
