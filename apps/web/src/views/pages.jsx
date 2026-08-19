import { EventList, FollowButton, LocalTime, TeamRow } from './components.jsx';
import { Layout } from './Layout.jsx';

export const Landing = ({ user, today, vapidKey }) => (
  <Layout title={null} user={user} vapidKey={vapidKey} canonical="/">
    <section class="hero">
      <h1>Never miss a game.</h1>
      <p>
        Follow any team in the world — 354 leagues across 17 sports — and get a web notification and
        an email an hour before kickoff, and again one minute out.
      </p>
      <p class="hero-actions">
        <a class="cta" href="/sports">
          {user ? 'Find your teams' : "Start following — it's free"}
        </a>
        <a class="ghost" href="/sports">
          Browse by sport
        </a>
      </p>
      <p class="muted small">Free forever. No app to install — add it to your home screen.</p>
    </section>

    <section>
      <h2>Today</h2>
      <EventList events={today} emptyText="No games scheduled today." />
    </section>
  </Layout>
);

/** Step 1 of the picker: sport. */
export const SportsIndex = ({ user, sports }) => (
  <Layout title="Sports" user={user} canonical="/sports">
    <h1>Browse by sport</h1>
    <p class="muted">Pick a sport, then a league, then follow the teams you care about.</p>
    <ol class="crumbs" aria-label="Breadcrumb">
      <li aria-current="page">Sport</li>
      <li>League</li>
      <li>Team</li>
    </ol>
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
  </Layout>
);

/** Step 2: league. Following a whole league is offered here too. */
export const SportPage = ({ user, sport, leagues }) => (
  <Layout title={sport} user={user} canonical={`/sports/${sport}`}>
    <ol class="crumbs" aria-label="Breadcrumb">
      <li>
        <a href="/sports">Sports</a>
      </li>
      <li aria-current="page">{sport.replace(/-/g, ' ')}</li>
    </ol>
    <h1>{sport.replace(/-/g, ' ')}</h1>
    <p class="muted">{leagues.length} leagues. Open one to follow its teams.</p>
    <ul class="leagues">
      {leagues.map((l) => (
        <li>
          <a href={`/leagues/${l.slug}`}>{l.name}</a>
          <FollowButton
            user={user}
            subjectType="league"
            subjectId={l.id}
            following={l.following}
            next={`/sports/${sport}`}
            label="league"
          />
        </li>
      ))}
    </ul>
  </Layout>
);

/** Step 3: teams. This is the page that was missing entirely. */
export const LeaguePage = ({ user, league, teams, events, following }) => (
  <Layout title={league.name} user={user} canonical={`/leagues/${league.slug}`}>
    <ol class="crumbs" aria-label="Breadcrumb">
      <li>
        <a href="/sports">Sports</a>
      </li>
      <li>
        <a href={`/sports/${league.sport}`}>{league.sport.replace(/-/g, ' ')}</a>
      </li>
      <li aria-current="page">{league.name}</li>
    </ol>

    <div class="page-head">
      <h1>{league.name}</h1>
      <FollowButton
        user={user}
        subjectType="league"
        subjectId={league.id}
        following={following}
        next={`/leagues/${league.slug}`}
        label="every game"
      />
    </div>
    <p class="muted small">
      Following the league notifies you about every fixture in it. Follow individual teams below to
      hear only about them.
    </p>

    <h2>Teams ({teams.length})</h2>
    {teams.length === 0 ? (
      <p class="empty">
        No teams recorded yet — they appear once this league's fixtures are synced.
      </p>
    ) : (
      <ul class="teams">
        {teams.map((t) => (
          <TeamRow team={t} user={user} next={`/leagues/${league.slug}`} />
        ))}
      </ul>
    )}

    <h2>Upcoming fixtures</h2>
    {/* Most leagues are out of season most of the year, which is not the same as
        broken. Say which one it is, and keep the follow controls useful either way. */}
    <EventList
      events={events}
      emptyText={
        teams.length > 0
          ? 'Nothing scheduled yet — this competition is between seasons. Follow its teams now and you will be told when they play.'
          : 'No fixtures scheduled.'
      }
    />
  </Layout>
);

export const TeamPage = ({ user, team, events, following }) => (
  <Layout title={team.display_name} user={user} canonical={`/teams/${team.slug}`}>
    <ol class="crumbs" aria-label="Breadcrumb">
      <li>
        <a href="/sports">Sports</a>
      </li>
      {team.sport ? (
        <li>
          <a href={`/sports/${team.sport}`}>{team.sport.replace(/-/g, ' ')}</a>
        </li>
      ) : null}
      {team.league_slug ? (
        <li>
          <a href={`/leagues/${team.league_slug}`}>{team.league_name}</a>
        </li>
      ) : null}
      <li aria-current="page">{team.display_name}</li>
    </ol>

    <div class="page-head">
      <h1>
        {team.logo_url ? <img src={team.logo_url} alt="" width="36" height="36" /> : null}
        {team.display_name}
      </h1>
      <FollowButton
        user={user}
        subjectType="team"
        subjectId={team.id}
        following={following}
        next={`/teams/${team.slug}`}
      />
    </div>
    <p class="muted small">
      {following
        ? "You'll get a reminder an hour before each of these, and again a minute out."
        : 'Follow to get a reminder an hour before each game, and again a minute out.'}
    </p>

    <EventList events={events} emptyText="Nothing scheduled for this team yet." />
  </Layout>
);

export const Following = ({ user, events, follows, vapidKey }) => (
  <Layout title="My games" user={user} vapidKey={vapidKey}>
    <h1>My games</h1>

    {/* Rendered always and revealed by script once it knows the real state, so the
        control can report on / off / blocked rather than only offering to turn on. */}
    <div id="push-optin" hidden class="notice">
      <p id="push-state">Get a notification an hour before kickoff, and one minute out.</p>
      <button type="button" id="enable-push">
        Turn on notifications
      </button>
      <p id="push-msg" class="feedback" hidden />
    </div>

    {follows.length === 0 ? (
      <p class="empty">
        You're not following anything yet. <a href="/sports">Browse by sport</a> to find your teams.
      </p>
    ) : (
      <>
        <h2>Following ({follows.length})</h2>
        <ul class="chips">
          {follows.map((f) => (
            <li class="chip">
              {f.label}
              <form method="post" action="/api/unfollow" class="inline">
                <input type="hidden" name="subject_type" value={f.subject_type} />
                <input type="hidden" name="subject_id" value={f.subject_id} />
                <input type="hidden" name="next" value="/following" />
                <button type="submit" aria-label={`Unfollow ${f.label}`}>
                  ×
                </button>
              </form>
            </li>
          ))}
        </ul>
      </>
    )}

    <h2>Coming up</h2>
    <EventList events={events} emptyText="Nothing coming up for what you follow." />
  </Layout>
);

export const EventPage = ({ user, event, offers, entitlement }) => (
  <Layout title={event.name} user={user} canonical={`/events/${event.id}`}>
    <h1>
      {event.away_name && event.home_name ? `${event.away_name} at ${event.home_name}` : event.name}
    </h1>
    <p class="muted">
      {event.league_name}
      {event.venue ? ` · ${event.venue}` : ''}
    </p>
    <p>
      <LocalTime at={event.starts_at} />
    </p>

    <section class="stream">
      <h2>Watch</h2>
      {entitlement ? (
        <p class="ok">
          You have access to this game.{' '}
          <a class="cta" href={`/events/${event.id}/watch`}>
            Open the stream
          </a>
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

export const SignIn = ({ mode, sent, next }) => (
  <Layout title={mode === 'signup' ? 'Create your account' : 'Sign in'}>
    <section class="auth">
      <h1>{mode === 'signup' ? 'Create your account' : 'Sign in'}</h1>
      {sent ? (
        <p class="ok">
          If that address can receive mail, a sign-in link is on its way. It works once and expires
          in 20 minutes.
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
              <input
                type="email"
                name="email"
                required
                autocomplete="email"
                placeholder="you@example.com"
              />
            </label>
            <button class="cta" type="submit">
              Email me a link
            </button>
          </form>

          <div class="or">or</div>
          <button type="button" id="passkey-signin" class="ghost">
            Use a passkey
          </button>
          <p id="passkey-signin-msg" class="feedback" hidden />

          <p class="muted small">
            {mode === 'signup' ? (
              <>
                Already have an account? <a href="/login">Sign in</a> — same link either way.
              </>
            ) : (
              <>
                No account yet? <a href="/signup">Create one</a> — the link makes it for you.
              </>
            )}
          </p>
        </>
      )}
    </section>
  </Layout>
);

const COMMON_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Lagos',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
];

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
              <input
                type="checkbox"
                name="channels"
                value={c}
                checked={prefs.channels.includes(c)}
              />
              {c === 'webpush' ? 'Web notification' : 'Email'}
            </label>
          ))}
        </fieldset>
        <button class="cta" type="submit">
          Save
        </button>
      </form>
    </section>

    <section>
      <h2>Time zone</h2>
      {/* Pages show times in your browser's zone automatically. This is only for
          email, which is rendered on a server with no browser to ask. */}
      <p class="muted small">
        Times on the site follow your browser (<span data-tz-label>your device</span>). This setting
        is what emailed reminders use.
      </p>
      <form method="post" action="/api/timezone">
        <label>
          Zone for emails
          <select name="timezone">
            {[...new Set([user.timezone ?? 'UTC', ...COMMON_ZONES])].map((z) => (
              <option value={z} selected={z === (user.timezone ?? 'UTC')}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <button class="cta" type="submit">
          Save time zone
        </button>
      </form>
    </section>

    <section>
      <h2>Passkeys</h2>
      {passkeys.length === 0 ? (
        <p class="muted">No passkeys yet. Add one to sign in without waiting for email.</p>
      ) : (
        <ul class="passkeys">
          {passkeys.map((p) => (
            <li>
              <strong>{(p.transports ?? []).join(', ') || 'Passkey'}</strong>
              <span class="muted">
                added {new Date(p.created_at).toLocaleDateString()}
                {p.last_used_at
                  ? ` · last used ${new Date(p.last_used_at).toLocaleDateString()}`
                  : ' · never used'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" id="add-passkey" class="ghost">
        Add a passkey
      </button>
      <p id="add-passkey-msg" class="feedback" hidden />
    </section>

    <section>
      <h2>Account</h2>
      <p class="muted">{user.email}</p>
      <form method="post" action="/api/auth/logout">
        <button type="submit" class="ghost">
          Sign out
        </button>
      </form>
    </section>
  </Layout>
);

export const About = ({ user, stats }) => (
  <Layout title="About" user={user} canonical="/about">
    <h1>About TipoffWatch</h1>
    <p>
      A calendar for people who keep missing the start of games. Follow any team or competition and
      get told an hour before kickoff, and again a minute out — by web notification, email, or both.
    </p>

    <h2>What's in the directory</h2>
    <ul class="stats">
      <li>
        <strong>{stats.sports}</strong> sports
      </li>
      <li>
        <strong>{stats.leagues}</strong> leagues
      </li>
      <li>
        <strong>{stats.teams}</strong> teams
      </li>
      <li>
        <strong>{stats.upcoming_events}</strong> upcoming fixtures
      </li>
    </ul>
    <p class="muted small">
      Fixtures last refreshed {stats.last_sync ? <LocalTime at={stats.last_sync} /> : 'not yet'}.
    </p>

    <h2>Where the data comes from</h2>
    <p>
      Schedules, teams and scores come from <strong>ESPN's public JSON API</strong> (
      <code>site.api.espn.com</code> and <code>sports.core.api.espn.com</code>). We are not
      affiliated with ESPN.
    </p>
    <p class="muted">
      Every response is normalised and stored here, so the calendar keeps working when the upstream
      is slow or unavailable — it goes stale rather than blank. Fixtures refresh every few hours and
      the league catalogue daily.
    </p>

    <h2>Times</h2>
    <p class="muted">
      All times are stored in UTC and shown in your browser's own time zone (
      <span data-tz-label>your device</span>). Emailed reminders use the zone set in{' '}
      <a href="/settings">settings</a>, since an email has no browser to ask.
    </p>

    <h2>Is it really free?</h2>
    <p>
      Following teams, the calendar and the reminders are free and stay free. The only thing anyone
      pays for is a live stream, when someone is sharing one.
    </p>

    <h2>Open data</h2>
    <p>
      The schedule is public data, so the <a href="/api/v1">API</a> is open and needs no key. Take
      what you need.
    </p>
  </Layout>
);

export const NotFound = ({ user }) => (
  <Layout title="Not found" user={user}>
    <h1>Not found</h1>
    <p>
      <a href="/">Back to today's games</a>
    </p>
  </Layout>
);
