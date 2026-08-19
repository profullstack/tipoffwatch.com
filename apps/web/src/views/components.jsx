/** Shared bits of markup. Kept small and dumb on purpose. */

const fmtTime = (d, tz) =>
  new Date(d).toLocaleTimeString('en-US', {
    timeZone: tz || 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  });

const fmtDay = (d, tz) =>
  new Date(d).toLocaleDateString('en-US', {
    timeZone: tz || 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

export const StateBadge = ({ state, detail }) => {
  if (state === 'in') return <span class="badge live">● Live</span>;
  if (state === 'post') return <span class="badge done">{detail ?? 'Final'}</span>;
  return null;
};

export const EventRow = ({ event, tz, user, following }) => (
  <li class={`event ${event.state}`}>
    <time datetime={new Date(event.starts_at).toISOString()}>
      <span class="t">{fmtTime(event.starts_at, tz)}</span>
      <span class="d">{fmtDay(event.starts_at, tz)}</span>
    </time>

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

    {event.state === 'post' && event.home_score !== null ? (
      <span class="score">
        {event.away_score}–{event.home_score}
      </span>
    ) : null}

    {/* A plain form, so following works with JavaScript off. */}
    {user && event.home_team_id ? (
      <form method="post" action={following ? '/api/unfollow' : '/api/follow'} class="follow">
        <input type="hidden" name="subject_type" value="team" />
        <input type="hidden" name="subject_id" value={event.home_team_id} />
        <input type="hidden" name="next" value="/following" />
        <button type="submit" title={following ? 'Unfollow' : 'Follow the home team'}>
          {following ? '★' : '☆'}
        </button>
      </form>
    ) : null}
  </li>
);

export const EventList = ({ events, tz, user, emptyText }) =>
  events.length === 0 ? (
    <p class="empty">{emptyText ?? 'Nothing scheduled.'}</p>
  ) : (
    <ul class="events">
      {events.map((e) => (
        <EventRow event={e} tz={tz} user={user} />
      ))}
    </ul>
  );
