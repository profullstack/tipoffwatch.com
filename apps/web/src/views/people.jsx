import { Word } from '@tipoff/config';
import { EventList, LocalTime } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * People pages: a profile, an inbox, one conversation.
 *
 * Kept out of pages.jsx because that file is already the whole fixture side of the
 * site, and these share nothing with it but the layout.
 *
 * The thread through all three is restraint about what a profile publishes. There
 * is no email, no location, no last-seen and no activity log -- none of it is
 * needed to follow a person, and all of it is a liability once the page is public.
 */

/**
 * What to call somebody in a list.
 *
 * A chosen display name, then the handle. Accounts have neither until their owner
 * visits Settings, and a magic link makes an account without asking -- so this has
 * to render something for a real person who has published no name at all. It says
 * so, rather than printing "@null" or falling back to a fragment of their email
 * address, which they never chose to publish either.
 */
const nameOf = (p) => p.display_name ?? (p.handle ? `@${p.handle}` : 'Someone');

/**
 * One person in a follower or following list.
 *
 * Linked only when there is a page at the other end, which needs both a handle and
 * a profile its owner has not hidden -- /u/:handle answers 404 for a hidden one,
 * and there is no URL at all without a handle. Linking unconditionally put dead
 * links on a public page and made hiding your profile look like being deleted.
 *
 * Everyone is still listed. The follow is a fact about the profile being read, and
 * what somebody has not set up is a page, not their existence: a follower list that
 * quietly dropped them reported fewer followers than there are.
 */
const Person = ({ person }) =>
  person.handle && person.profile_public ? (
    <a href={`/u/${person.handle}`}>{nameOf(person)}</a>
  ) : (
    <span>{nameOf(person)}</span>
  );

/**
 * Someone's public page.
 *
 * Public by default, because the rest of the site reads without an account and a
 * profile shows only what its owner chose to put there. `profile_public` is the
 * opt-out; the owner still sees their own page so it never looks broken to them.
 */
export const ProfilePage = ({
  user,
  profile,
  counts,
  followers,
  following,
  follows = [],
  upcoming = [],
  isFollowing,
  isSelf,
}) => (
  <Layout title={nameOf(profile)} user={user} canonical={`/u/${profile.handle}`}>
    <div class="page-head">
      <h1>
        {nameOf(profile)}
        {profile.display_name ? <span class="handle muted">@{profile.handle}</span> : null}
      </h1>
      {isSelf ? (
        <a class="ghost small-btn" href="/settings">
          Edit profile
        </a>
      ) : user ? (
        <div class="form-actions">
          <form
            method="post"
            action={isFollowing ? '/api/users/unfollow' : '/api/users/follow'}
            class="inline"
          >
            <input type="hidden" name="handle" value={profile.handle} />
            <button class={isFollowing ? 'ghost small-btn' : 'cta small-btn'} type="submit">
              {isFollowing ? 'Following' : 'Follow'}
            </button>
          </form>
          <a class="ghost small-btn" href={`/messages/${profile.handle}`}>
            Message
          </a>
        </div>
      ) : (
        <a class="cta small-btn" href={`/login?next=%2Fu%2F${profile.handle}`}>
          Sign in to follow
        </a>
      )}
    </div>

    {profile.bio ? <p class="bio">{profile.bio}</p> : null}

    {!profile.profile_public ? (
      <p class="feedback">Your profile is hidden. Only you can see this page.</p>
    ) : null}

    <ul class="stat">
      <li>
        <strong class="num">{counts.followers.toLocaleString('en-US')}</strong>
        <span>Followers</span>
      </li>
      <li>
        <strong class="num">{counts.following.toLocaleString('en-US')}</strong>
        <span>Following</span>
      </li>
      <li>
        <strong class="num">{counts.teams.toLocaleString('en-US')}</strong>
        <span>{Word.participants} followed</span>
      </li>
    </ul>

    {/* What they follow, and what that means is about to happen. Both were counted
        in the stat row above and named nowhere, which made the number the end of the
        page rather than the start of it: 44 teams followed, and no way to ask which
        44 or when any of them play.

        The chips are links, not the unfollow controls the owner gets on /following.
        Nobody can unfollow on somebody else's behalf, and a chip that did nothing
        would be the only dead one on the site. */}
    <h2>Teams &amp; competitions</h2>
    {follows.length === 0 ? (
      <p class="empty">Not following any teams yet.</p>
    ) : (
      <>
        <ul class="chips">
          {follows.map((f) => (
            <li class="chip">
              <a href={`/${f.subject_type === 'team' ? 'teams' : 'leagues'}/${f.slug}`}>
                {f.label}
              </a>
            </li>
          ))}
        </ul>
        {/* The list is capped, so say so with the real total rather than letting the
            last chip imply the end. counts.teams is the count the stat row shows. */}
        {counts.teams > follows.length ? (
          <p class="muted small">
            Showing {follows.length.toLocaleString('en-US')} of{' '}
            {counts.teams.toLocaleString('en-US')}.
          </p>
        ) : null}
      </>
    )}

    <h2>Coming up</h2>
    <EventList
      events={upcoming}
      emptyText={
        follows.length === 0
          ? 'Nothing coming up yet.'
          : 'Nothing scheduled for what they follow right now.'
      }
    />

    {/* Both lists are a preview of a page of their own. The profile shows the
        most recent handful and says how many there are in total, so the heading
        is never a promise the list below it does not keep. */}
    <PeopleSection
      title="Followers"
      href={`/u/${profile.handle}/followers`}
      people={followers}
      total={counts.followers}
      emptyText="Nobody yet."
    />

    <PeopleSection
      title="Following"
      href={`/u/${profile.handle}/following`}
      people={following}
      total={counts.following}
      emptyText="Not following anyone yet."
    />
  </Layout>
);

/**
 * One of the two people lists on a profile, as a preview.
 *
 * The heading links to the full page whether or not the preview is truncated, so
 * the URL is discoverable rather than something you have to know exists. The "see
 * all" line only appears when there is genuinely more, and names the real total --
 * the number that has now twice been the half of this page that lied.
 */
const PeopleSection = ({ title, href, people, total, emptyText }) => (
  <>
    <h2>
      <a href={href}>{title}</a>
    </h2>
    {people.length === 0 ? (
      <p class="empty">{emptyText}</p>
    ) : (
      <>
        <ul class="people">
          {people.map((p) => (
            <li>
              <Person person={p} />
            </li>
          ))}
        </ul>
        {total > people.length ? (
          <p class="muted small">
            <a href={href}>See all {total.toLocaleString('en-US')}</a>
          </p>
        ) : null}
      </>
    )}
  </>
);

/**
 * The whole of one list, on its own page.
 *
 * Paged rather than capped. The profile's preview stops at 24 and says so; this
 * page is where "and the other 900" has to actually be answerable, so a cap here
 * would just move the same lie one click deeper.
 *
 * Offset paging, not a cursor: the ordering is newest-follow-first with the id as
 * a tiebreak, which is stable enough for a list that changes when somebody presses
 * a button, and the alternative is a cursor scheme for a page almost nobody will
 * reach the second screen of.
 */
export const PeopleListPage = ({ user, profile, kind, people, total, page, pageSize }) => {
  const title = kind === 'followers' ? 'Followers' : 'Following';
  const start = page * pageSize;
  const hasPrev = page > 0;
  const hasNext = start + people.length < total;
  const href = (p) => `/u/${profile.handle}/${kind}${p > 0 ? `?page=${p + 1}` : ''}`;

  return (
    <Layout
      title={`${title} · ${nameOf(profile)}`}
      user={user}
      canonical={`/u/${profile.handle}/${kind}`}
    >
      <div class="page-head">
        <h1>{title}</h1>
        <a class="ghost small-btn" href={`/u/${profile.handle}`}>
          Back to {nameOf(profile)}
        </a>
      </div>

      <p class="muted">
        {total === 0
          ? kind === 'followers'
            ? `Nobody follows ${nameOf(profile)} yet.`
            : `${nameOf(profile)} is not following anyone yet.`
          : `${total.toLocaleString('en-US')} ${total === 1 ? 'person' : 'people'}.`}
      </p>

      {people.length === 0 ? null : (
        <ul class="people">
          {people.map((p) => (
            <li>
              <Person person={p} />
            </li>
          ))}
        </ul>
      )}

      {hasPrev || hasNext ? (
        <nav class="pager" aria-label="Pages">
          {hasPrev ? (
            <a class="ghost small-btn" href={href(page - 1)}>
              Newer
            </a>
          ) : null}
          {hasNext ? (
            <a class="ghost small-btn" href={href(page + 1)}>
              Older
            </a>
          ) : null}
        </nav>
      ) : null}
    </Layout>
  );
};

/** Every conversation, newest first, with the last thing said in each. */
export const Inbox = ({ user, threads }) => (
  <Layout title="Messages" user={user}>
    <h1>Messages</h1>
    {threads.length === 0 ? (
      <p class="empty">No messages yet. Open someone's profile and choose Message to start one.</p>
    ) : (
      <ul class="threads">
        {threads.map((t) => (
          <li class={t.unread ? 'unread' : ''}>
            <a href={`/messages/${t.handle}`}>
              <span class="thread-who">
                {nameOf(t)}
                {/* role="img" so the label is actually exposed: aria-label on a
                    bare span is ignored by screen readers and by the linter. */}
                {t.unread ? <span class="dot" role="img" aria-label="unread" /> : null}
              </span>
              <span class="thread-last muted">
                {t.outgoing ? 'You: ' : ''}
                {t.body.length > 90 ? `${t.body.slice(0, 90)}…` : t.body}
              </span>
              <LocalTime at={t.created_at} />
            </a>
          </li>
        ))}
      </ul>
    )}
  </Layout>
);

/** One conversation. Oldest at the top, composer at the bottom. */
export const Thread = ({ user, other, messages, blocked }) => (
  <Layout title={nameOf(other)} user={user}>
    <ol class="crumbs" aria-label="Breadcrumb">
      <li>
        <a href="/messages">Messages</a>
      </li>
      <li aria-current="page">{nameOf(other)}</li>
    </ol>

    <div class="page-head">
      <h1>
        <a href={`/u/${other.handle}`}>{nameOf(other)}</a>
      </h1>
      <form method="post" action="/api/users/block" class="inline">
        <input type="hidden" name="handle" value={other.handle} />
        <button class="ghost small-btn danger" type="submit">
          Block
        </button>
      </form>
    </div>

    {blocked ? (
      <p class="feedback error">This conversation is closed. One of you has blocked the other.</p>
    ) : (
      <>
        {messages.length === 0 ? (
          <p class="empty">Say something.</p>
        ) : (
          <ul class="messages">
            {messages.map((m) => (
              <li class={m.sender_id === user.id ? 'mine' : 'theirs'}>
                <p class="msg-body">{m.body}</p>
                <LocalTime at={m.created_at} />
              </li>
            ))}
          </ul>
        )}

        <form method="post" action="/api/messages">
          <input type="hidden" name="handle" value={other.handle} />
          <label class="field">
            <span>Message</span>
            <textarea name="body" required maxlength="4000" placeholder="Write a message" />
          </label>
          <button class="cta" type="submit">
            Send
          </button>
        </form>
      </>
    )}
  </Layout>
);
