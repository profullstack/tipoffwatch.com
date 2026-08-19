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
  <Layout
    title={league.name}
    user={user}
    canonical={`/leagues/${league.slug}`}
    feedUrl={`/feeds/league/${league.slug}.xml`}
    feedTitle={`${league.name} fixtures`}
  >
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
  <Layout
    title={team.display_name}
    user={user}
    canonical={`/teams/${team.slug}`}
    feedUrl={`/feeds/team/${team.slug}.xml`}
    feedTitle={`${team.display_name} fixtures`}
  >
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

export const Following = ({ user, events, follows, vapidKey, calendarUrl }) => (
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

    {/* Calendar subscription. The URL carries a per-user token because calendar
        clients poll without cookies; rotating it invalidates every copy. */}
    {calendarUrl ? (
      <section class="notice">
        <h2 style="margin-top:0">Add to your calendar</h2>
        <p class="muted small">
          Every game you follow, kept up to date automatically, with an alert an hour before
          kickoff.
        </p>
        <p class="hero-actions">
          <a
            class="cta"
            href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(calendarUrl.replace(/^https:/, 'webcal:'))}`}
            rel="noopener"
          >
            Google Calendar
          </a>
          <a class="ghost" href={calendarUrl.replace(/^https:/, 'webcal:')}>
            Apple / Outlook
          </a>
          <a class="ghost" href={calendarUrl}>
            Raw .ics
          </a>
        </p>
        <p class="muted small">
          Anyone with this link can see the games you follow.{' '}
          <form method="post" action="/api/calendar/rotate" class="inline">
            <button type="submit">Reset the link</button>
          </form>
        </p>
      </section>
    ) : null}

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

/** One side of the scoreboard. */
const Side = ({ name, slug, logo, score, record, showScore }) => (
  <div class="side">
    {logo ? <img src={logo} alt="" width="56" height="56" /> : <span class="team-blank big" />}
    <div class="side-name">
      {slug ? <a href={`/teams/${slug}`}>{name}</a> : <span>{name}</span>}
      {record ? <span class="meta">{record}</span> : null}
    </div>
    {showScore ? <span class="side-score num">{score ?? '—'}</span> : null}
  </div>
);

export const EventPage = ({
  user,
  event,
  offers,
  entitlement,
  plays = [],
  comments = [],
  followingHome,
  followingAway,
}) => {
  const live = event.state === 'in';
  const done = event.state === 'post';
  const showScore = live || done;

  // The feed arrives newest-first. Scoring plays read better oldest-first, as a
  // narrative; the latest-action list stays newest-first.
  const scoringPlays = plays
    .filter((p) => p.scoring)
    .slice(0, 12)
    .reverse();
  const recentPlays = plays.slice(0, 15);

  return (
    <Layout title={event.name} user={user} canonical={`/events/${event.id}`}>
      <ol class="crumbs" aria-label="Breadcrumb">
        <li>
          <a href="/sports">Sports</a>
        </li>
        {event.sport ? (
          <li>
            <a href={`/sports/${event.sport}`}>{event.sport.replace(/-/g, ' ')}</a>
          </li>
        ) : null}
        {event.league_slug ? (
          <li>
            <a href={`/leagues/${event.league_slug}`}>{event.league_name}</a>
          </li>
        ) : null}
        <li aria-current="page">{event.short_name ?? event.name}</li>
      </ol>

      {/* data-event-id and data-live let the client refresh this block in place
          while a game is on, instead of showing a score that stopped moving. */}
      <section
        class={`scoreboard${live ? ' live' : ''}`}
        data-event-id={event.id}
        data-live={live ? 'true' : null}
      >
        <Side
          name={event.away_name ?? 'Away'}
          slug={event.away_slug}
          logo={event.away_logo}
          score={event.away_score}
          record={event.away_record}
          showScore={showScore}
        />

        <div class="middle">
          {live ? (
            <span class="badge live" data-status>
              {event.status_detail ?? 'Live'}
            </span>
          ) : done ? (
            <span class="badge done" data-status>
              {event.status_detail ?? 'Final'}
            </span>
          ) : (
            <LocalTime at={event.starts_at} />
          )}
          {showScore ? null : <span class="vs">vs</span>}
        </div>

        <Side
          name={event.home_name ?? 'Home'}
          slug={event.home_slug}
          logo={event.home_logo}
          score={event.home_score}
          record={event.home_record}
          showScore={showScore}
        />
      </section>

      <ul class="stat">
        <li>
          <strong>{event.league_name}</strong>
          <span>Competition</span>
        </li>
        {event.venue ? (
          <li>
            <strong>{event.venue}</strong>
            <span>{event.venue_city ?? 'Venue'}</span>
          </li>
        ) : null}
        {event.broadcast ? (
          <li>
            <strong>{event.broadcast}</strong>
            <span>Watch on TV</span>
          </li>
        ) : null}
        {event.attendance ? (
          <li>
            <strong class="num">{event.attendance.toLocaleString('en-US')}</strong>
            <span>Attendance</span>
          </li>
        ) : null}
      </ul>

      <h2>Follow</h2>
      <p class="muted small">
        Following either side puts this game — and the rest of their season — in your reminders.
      </p>
      <div class="follow-pair">
        {event.away_team_id ? (
          <FollowButton
            user={user}
            subjectType="team"
            subjectId={event.away_team_id}
            following={followingAway}
            next={`/events/${event.id}`}
            label={event.away_name}
          />
        ) : null}
        {event.home_team_id ? (
          <FollowButton
            user={user}
            subjectType="team"
            subjectId={event.home_team_id}
            following={followingHome}
            next={`/events/${event.id}`}
            label={event.home_name}
          />
        ) : null}
      </div>

      {plays.length > 0 ? (
        <section>
          <h2>{live ? 'Live action' : 'How it went'}</h2>

          {/* Scoring plays first: for most sports the raw feed is pitch-by-pitch or
              possession-by-possession, and the recap someone actually wants is the
              handful of moments that changed the score. */}
          {scoringPlays.length > 0 ? (
            <ul class="plays scoring">
              {scoringPlays.map((p) => (
                <li>
                  <span class="play-when num">
                    {p.away_score}–{p.home_score}
                  </span>
                  <span class="play-text">
                    {p.text}
                    <span class="meta"> {p.period_label}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <h3 class="muted small">Latest</h3>
          <ul class="plays">
            {recentPlays.map((p) => (
              <li class={p.scoring ? 'scored' : null}>
                <span class="play-when">{p.period_label ?? ''}</span>
                <span class="play-text">{p.text}</span>
              </li>
            ))}
          </ul>
          {live ? (
            <p class="muted small">Updates every couple of minutes while the game is on.</p>
          ) : null}
        </section>
      ) : null}

      <section id="comments" class="comments-panel">
        <div class="comments-head">
          <h2>Comments</h2>
          <span class="count num">{comments.length}</span>
        </div>

        {user ? (
          <form method="post" action={`/api/events/${event.id}/comments`} class="composer">
            <span class="avatar" aria-hidden="true">
              {String(user.email ?? '?')
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <div class="composer-body">
              <label class="sr-only" for="body">
                Your comment
              </label>
              <textarea
                id="body"
                name="body"
                rows="3"
                maxlength="2000"
                placeholder={live ? "What's happening?" : 'Say something about this game'}
                required
              />
              <div class="composer-foot">
                <span class="muted small">Up to 2,000 characters.</span>
                <button class="cta small-btn" type="submit">
                  Post
                </button>
              </div>
            </div>
          </form>
        ) : (
          /* One message, not two. The old version said "sign in" and "nothing yet"
             as separate lines, which read as two different empty states. */
          <div class="composer signed-out">
            <span class="avatar" aria-hidden="true">
              +
            </span>
            <div class="composer-body">
              <p class="composer-prompt">
                {comments.length === 0 ? 'No one has said anything yet.' : 'Join the conversation.'}
              </p>
              <a
                class="cta small-btn"
                href={`/login?next=${encodeURIComponent(`/events/${event.id}`)}`}
              >
                Sign in to comment
              </a>
            </div>
          </div>
        )}

        {comments.length > 0 ? (
          <ul class="comments">
            {comments.map((c) => (
              <li>
                <span class="avatar" aria-hidden="true">
                  {String(c.email ?? '?')
                    .slice(0, 1)
                    .toUpperCase()}
                </span>
                <div class="comment-main">
                  <div class="comment-head">
                    {/* Local part only: the full address is nobody else's business. */}
                    <strong>{String(c.email ?? '').split('@')[0]}</strong>
                    <LocalTime at={c.created_at} />
                    {user && c.user_id === user.id ? (
                      <form method="post" action={`/api/comments/${c.id}/delete`} class="inline">
                        <button type="submit" aria-label="Delete comment">
                          ×
                        </button>
                      </form>
                    ) : null}
                  </div>
                  <p class="comment-body">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : user ? (
          <p class="empty">Be the first.</p>
        ) : null}
      </section>

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
          <p class="muted">
            Nobody is sharing a stream for this game yet.
            {event.broadcast ? ` It is on ${event.broadcast}.` : ''}
          </p>
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
};

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
      {/* This zone drives the whole site, not just email. It used to apply to email
          only, so someone who set PST here still saw their device's zone on every
          page and reasonably concluded the app was ignoring them. */}
      <p class="muted small">
        Every time on the site, and in emailed reminders, is shown in this zone. Leave it as
        detected and it follows your device (<span data-tz-label>your device</span>).
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
