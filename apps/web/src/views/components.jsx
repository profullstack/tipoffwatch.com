/** Shared bits of markup. Kept small and dumb on purpose. */

/**
 * Times are rendered in UTC on the server and localised in the browser.
 *
 * Schedule pages are cached in Redis and served byte-identical to everyone, so a
 * time baked in one viewer's zone would be wrong for the next. The server emits a
 * machine-readable UTC `datetime` plus a readable UTC fallback, and public/app.js
 * rewrites the text to the viewer's own zone. With JavaScript off the page still
 * shows a correct time, explicitly labelled UTC rather than silently wrong.
 */
const fmtTimeUtc = (d) =>
  new Date(d).toLocaleTimeString('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  });

const fmtDayUtc = (d) =>
  new Date(d).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

export const LocalTime = ({ at }) => {
  const iso = new Date(at).toISOString();
  return (
    <time datetime={iso} data-local>
      <span class="t" data-local-time>
        {fmtTimeUtc(at)}
      </span>
      <span class="d" data-local-day>
        {fmtDayUtc(at)}
      </span>
    </time>
  );
};

/**
 * The time column for a fixture row.
 *
 * Once a game is under way its kickoff time is the least interesting thing about
 * it, so the column shows how far in it is instead -- with the scheduled time kept
 * underneath for anyone checking they are watching the right one.
 */
export const RowTime = ({ event }) => {
  if (event.state !== 'in') return <LocalTime at={event.starts_at} />;
  return (
    <time datetime={new Date(event.starts_at).toISOString()} data-local>
      <span class="t live-clock">{event.status_detail ?? 'Live'}</span>
      <span class="d" data-local-time>
        {fmtTimeUtc(event.starts_at)}
      </span>
    </time>
  );
};

/**
 * Where a live game actually is: "Bot 6th", "Top 9th", "68'", "Q3 04:12".
 *
 * The provider already phrases this per sport, so it is passed through rather than
 * reassembled from period and clock -- an inning, a quarter and a football minute
 * are not the same shape and any generic formatting gets one of them wrong. The
 * badge used to say a flat "Live", which is the one thing the viewer already knows.
 */
export const StateBadge = ({ state, detail }) => {
  if (state === 'in') return <span class="badge live">{detail ?? 'Live'}</span>;
  if (state === 'post') return <span class="badge done">{detail ?? 'Final'}</span>;
  return null;
};

/** Follow / unfollow as a plain form, so it works with JavaScript off. */
export const FollowButton = ({ user, subjectType, subjectId, following, next, label }) => {
  if (!user) {
    // Just "Follow". The long "Sign in to follow" was wide enough to squeeze the
    // team name into two wrapped lines on every card; the link goes to sign-in
    // either way, and the title says so for anyone who wants the detail.
    return (
      <a
        class="ghost small-btn"
        title="Sign in to follow"
        href={`/login?next=${encodeURIComponent(next ?? '/')}`}
      >
        ☆ Follow
      </a>
    );
  }
  return (
    <form method="post" action={following ? '/api/unfollow' : '/api/follow'} class="inline">
      <input type="hidden" name="subject_type" value={subjectType} />
      <input type="hidden" name="subject_id" value={subjectId} />
      <input type="hidden" name="next" value={next ?? '/'} />
      {/* data-label lets the client rebuild the unfollowed wording without having to
          re-render the row from the server. */}
      <button
        type="submit"
        data-label={label ?? ''}
        class={following ? 'ghost small-btn following' : 'ghost small-btn'}
      >
        {following ? '★ Following' : `☆ Follow${label ? ` ${label}` : ''}`}
      </button>
    </form>
  );
};

export const EventRow = ({ event }) => (
  <li class={`event ${event.state}`}>
    <RowTime event={event} />

    <div class="matchup">
      <a href={`/events/${event.id}`}>
        {event.away_name && event.home_name
          ? `${event.away_name} at ${event.home_name}`
          : event.name}
      </a>
      <span class="meta">
        {event.league_name}
        {event.venue ? ` · ${event.venue}` : ''}
        <StateBadge state={event.state} detail={event.status_detail} />
      </span>
    </div>

    {/* Shown while a game is in progress too, not only once it is finished --
        a live row with no score was the whole point of watching it. */}
    {(event.state === 'in' || event.state === 'post') && event.home_score !== null ? (
      <span class={`score${event.state === 'in' ? ' live' : ''}`}>
        {event.away_score}–{event.home_score}
      </span>
    ) : null}
  </li>
);

export const EventList = ({ events, emptyText }) =>
  events.length === 0 ? (
    <p class="empty">{emptyText ?? 'Nothing scheduled.'}</p>
  ) : (
    <ul class="events">
      {events.map((e) => (
        <EventRow event={e} />
      ))}
    </ul>
  );

/** A team in the follow picker. */
export const TeamRow = ({ team, user, next }) => (
  <li class="team">
    {team.logo_url ? (
      <img src={team.logo_url} alt="" loading="lazy" width="28" height="28" />
    ) : (
      <span class="team-blank" />
    )}
    <div class="team-name">
      <a href={`/teams/${team.slug}`}>{team.display_name}</a>
      <span class="meta">
        {team.upcoming > 0 ? `${team.upcoming} upcoming` : 'no fixtures scheduled'}
      </span>
    </div>
    <FollowButton
      user={user}
      subjectType="team"
      subjectId={team.id}
      following={team.following}
      next={next}
    />
  </li>
);
