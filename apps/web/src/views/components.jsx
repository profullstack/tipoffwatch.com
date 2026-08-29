import { href } from '@tipoff/config';

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

/**
 * @param zone  also print which timezone the time is in. Worth it where someone
 *              is deciding whether they can watch (a single fixture); noise on a
 *              list, where every row would repeat the same word.
 *
 * The server renders UTC because it has no browser; localiseTimes() in app.js
 * rewrites all three spans to the visitor's zone on load.
 */
export const LocalTime = ({ at, zone = false }) => {
  const iso = new Date(at).toISOString();
  return (
    <time datetime={iso} data-local>
      <span class="t" data-local-time>
        {fmtTimeUtc(at)}
      </span>
      <span class="d" data-local-day>
        {fmtDayUtc(at)}
      </span>
      {zone ? (
        <span class="z" data-tz-abbr>
          UTC
        </span>
      ) : null}
    </time>
  );
};

/**
 * One line: "3:00 PM · Wed, Aug 19 · PDT".
 *
 * The separators are real text in the markup, not borders or gaps, because the
 * stacked version depends entirely on CSS to be legible -- there is no
 * whitespace between its spans, so anywhere the stylesheet does not reach (a new
 * context, or a browser still holding an old cached copy) it renders as
 * "3:00 PMWed, Aug 19PDT". This one reads correctly with no stylesheet at all.
 */
export const KickoffTime = ({ at }) => {
  const iso = new Date(at).toISOString();
  return (
    <time class="line" datetime={iso} data-local>
      <span data-local-time>{fmtTimeUtc(at)}</span>
      {' · '}
      <span data-local-day>{fmtDayUtc(at)}</span>
      {' · '}
      <span data-tz-abbr>UTC</span>
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
  // Whoever the button is about, in every state. Two of these sit side by side on
  // an event page, one per team, so a bare "Follow" leaves the reader guessing
  // which side each one is -- and "Following" with no name is worse, because it is
  // the state you most need to be able to read back.
  //
  // Callers that render a long list of one-team rows -- the team picker -- pass no
  // label at all, because the row already says the name right beside the button.
  const who = label ? ` ${label}` : '';

  if (!user) {
    return (
      <a
        class="ghost small-btn"
        title="Sign in to follow"
        href={`/login?next=${encodeURIComponent(next ?? '/')}`}
      >
        ☆ Follow{who}
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
        {following ? `★ Following${who}` : `☆ Follow${who}`}
      </button>
    </form>
  );
};

/**
 * Which competition this is, as a tag rather than as more grey text.
 *
 * The league name was already on the row, third in a run of muted metadata after
 * the venue -- which is where the eye stops reading. On a page that mixes 354
 * competitions, "is this MLB or is this college baseball" is the first question a
 * row has to answer, and a chip answers it at a glance where a sentence does not.
 *
 * The abbreviation where the provider gave us one, because that is what people
 * call these -- MLB, NCAAM, EPL -- and the full name otherwise. ESPN supplies the
 * abbreviation for the leagues anybody has heard of and leaves it null for the
 * long tail, which is exactly the split where a full name is worth the width.
 *
 * Two things a bare abbreviation cannot do, both reported:
 *
 *   1. Tell apart competitions named almost the same. Australia's NBL is really
 *      the "National Basketball League"; against the NBA's "National Basketball
 *      Association" that is one word, rendered as one letter. It was reported as
 *      the NBA being mislabelled -- the data was right and the chip could not be
 *      told apart, which from outside is the same defect. So the region is shown
 *      whenever we have one.
 *   2. Identify a league at all when the abbreviation is shared. Thirteen MMA
 *      promotions abbreviate to "BFC" and two summer leagues to "NBAGS". There
 *      the short form is not brevity, it is a coin flip, so the full name wins
 *      however long it is -- unless a region settles it, which is cheaper to
 *      read than a full name.
 *
 * `title` always carries the unabbreviated name, so a chip reading "NCAAB" is
 * still identifiable by anybody who does not already know it.
 */
export const LeagueTag = ({ event }) => {
  const short = event.league_abbr?.trim();
  const full = event.league_name?.trim();
  if (!short && !full) return null;

  const region = event.league_region?.trim();
  // A shared abbreviation names nothing on its own; prefer anything that does.
  const usable = short && !(event.league_abbr_ambiguous && !region);
  const base = usable ? short : full || short;
  const label = region ? `${base} · ${region}` : base;

  // The tooltip is the long form, and it is the only place the full name is
  // guaranteed to appear once the chip starts preferring a region.
  const hover = [full, region].filter(Boolean).join(' · ');
  const tag = (
    <span class="league-tag" title={hover && hover !== label ? hover : undefined}>
      {label}
    </span>
  );
  // Linked where we know where it goes. Not every list query carries the slug,
  // and a chip that navigates on some rows and not others is worse than one that
  // never does -- so this is decided per row rather than per list.
  return event.league_slug ? (
    <a class="league-tag-link" href={href.collection(event.league_slug)}>
      {tag}
    </a>
  ) : (
    tag
  );
};

/**
 * The set-by-set score, when the provider sends one.
 *
 * `score_detail` is jsonb and arrives either parsed or as a string depending on the
 * driver, so this is the single place that decides what "no detail" looks like,
 * rather than three call sites each guessing. It also carries its own `kind`: the
 * column is not tennis-shaped, and a renderer has to read the payload rather than
 * infer from the league it came from.
 *
 * An empty grid is rejected on purpose. A match that has not started sends two
 * empty per-set arrays, and a scoreboard of dashes reads as broken rather than as
 * "not yet".
 */
export function setScoreOf(event) {
  const raw = event?.score_detail;
  if (!raw) return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (parsed?.kind !== 'tennis') return null;
  const games = parsed.games;
  if (!Array.isArray(games) || games.length !== 2) return null;
  if (!Array.isArray(games[0]) || !Array.isArray(games[1])) return null;
  if (games[0].length === 0) return null;
  return parsed;
}

/**
 * The compact form, for a row in a list.
 *
 * The row already shows sets won, which for tennis is a summary rather than the
 * score. This is the thing anyone actually quotes -- 7-6 4-6 5-1 -- in the space of
 * a few characters. The points in the game being played go on the end only while
 * the match is live, because a finished match's last points read "0-0".
 */
export const SetScore = ({ event }) => {
  const d = setScoreOf(event);
  if (!d) return null;

  const sets = Math.max(d.games[0].length, d.games[1].length);
  const played = [];
  for (let i = 0; i < sets; i++) {
    const a = d.games[0][i];
    const b = d.games[1][i];
    // A set only one side has a number for is mid-write, not a scoreline.
    if (Number.isFinite(a) && Number.isFinite(b)) played.push(`${a}-${b}`);
  }
  if (played.length === 0) return null;

  return (
    <span class="setscore" title="Games in each set">
      {played.join(' ')}
      {d.points ? (
        <span class="pts">
          {/* A real space, not only the margin. Without one the two run together
              as "5-430-0" the moment the stylesheet does not reach the page --
              which it does not for anyone holding a cached copy of the old one. */}{' '}
          {d.tiebreak ? 'TB ' : ''}
          {d.points[0]}-{d.points[1]}
        </span>
      ) : null}
    </span>
  );
};

export const EventRow = ({ event, showBroadcast = false }) => (
  <li class={`event ${event.state}${event.following ? ' followed' : ''}`}>
    <RowTime event={event} />

    <div class="matchup">
      <a href={`/events/${event.id}`}>
        {/* The star marks a fixture the viewer already follows, so a schedule page
            reads the same way as the My games list. It is decorative for a signed-out
            visitor, who never has one. */}
        {event.following ? (
          <span
            class="followed-star"
            role="img"
            title="You follow one of these teams"
            aria-label="Following"
          >
            ★
          </span>
        ) : null}
        {event.away_name && event.home_name ? (
          <>
            {/* Which side is at home cannot be read from the order: North America
                writes the visitor first, most of the world writes the host first,
                and a row mixing both conventions in one list settles nothing. The
                tags say it outright -- except at a neutral ground, where there is
                nothing to say. */}
            {event.neutral_site ? null : (
              <abbr class="ha away" title="Away team">
                A
              </abbr>
            )}
            {event.away_name}
            <span class="join">{event.neutral_site ? 'vs' : 'at'}</span>
            {event.neutral_site ? null : (
              <abbr class="ha home" title="Home team">
                H
              </abbr>
            )}
            {event.home_name}
          </>
        ) : (
          event.name
        )}
      </a>
      <span class="meta">
        <LeagueTag event={event} />
        {event.venue ? ` ${event.venue}` : ''}
        {/* The arena name alone only means something to people who already know the
            city, which is nobody browsing 354 leagues. */}
        {event.venue_city ? `, ${event.venue_city}` : ''}
        <StateBadge state={event.state} detail={event.status_detail} />
        {/* Only where the list exists to answer "what can I watch" -- the Live now
            section. Everywhere else this row is about when something starts, and a
            channel name in the same breath as a kick-off time reads as noise. It is
            US-only and mostly near-term for most of the catalogue, so it is an
            addition to a row rather than a column that would sit empty. */}
        {showBroadcast && event.broadcast ? (
          <span class="on-tv" title="Where this is being shown">
            {event.broadcast}
          </span>
        ) : null}
      </span>
    </div>

    {/* Shown while a game is in progress too, not only once it is finished --
        a live row with no score was the whole point of watching it. */}
    {(event.state === 'in' || event.state === 'post') && event.home_score !== null ? (
      <span class={`score${event.state === 'in' ? ' live' : ''}`}>
        {event.away_score}–{event.home_score}
        {/* Sets alone is a summary, not a score: 1–1 is true and says almost
            nothing to somebody deciding whether to watch. */}
        <SetScore event={event} />
      </span>
    ) : null}
  </li>
);

export const EventList = ({ events, emptyText, showBroadcast = false }) =>
  events.length === 0 ? (
    <p class="empty">{emptyText ?? 'Nothing scheduled.'}</p>
  ) : (
    <ul class="events">
      {events.map((e) => (
        <EventRow event={e} showBroadcast={showBroadcast} />
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
      <a href={href.participant(team.slug)}>{team.display_name}</a>
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
