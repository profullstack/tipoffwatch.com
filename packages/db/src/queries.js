import { sql } from './index.js';

/**
 * Every query the app runs lives here. Route handlers and workers import from this
 * module and never write SQL themselves -- that is what makes a schema change one
 * grep instead of an archaeology dig.
 */

/**
 * A Postgres array literal.
 *
 * Bun's parameter serialiser stringifies a JS array with Array.prototype.toString,
 * so `['internal','hybrid']` reaches Postgres as `internal,hybrid` and is rejected
 * as a malformed array literal — silently breaking passkey registration, saving
 * reminder preferences, and the reminder fan-out's user lookup. Building the
 * literal here and casting at the call site is deterministic and does not depend
 * on how the driver decides to encode a parameter.
 */
export function pgArray(values) {
  const items = (values ?? []).map((v) =>
    // Unquoted NULL, not the string "null": a nullable column (a score before
    // kickoff, a clock for a sport that has none) must arrive as SQL NULL.
    v === null || v === undefined ? 'NULL' : `"${String(v).replace(/(["\\])/g, '\\$1')}"`,
  );
  return `{${items.join(',')}}`;
}

/* ---------------------------------------------------------------- accounts -- */

/**
 * Magic-link consumption creates the account if the address is new. There is no
 * separate registration path: proving you can read the mailbox IS the account.
 */
export async function findOrCreateUser(email) {
  const [row] = await sql`
    insert into users ${sql({ email })}
    on conflict (email) do update set last_seen_at = now()
    returning *
  `;
  return row;
}

/* ------------------------------------------------------------- passwords -- */

/**
 * The row a password sign-in checks against.
 *
 * Returns null for an address with no account, and a row with a null hash for an
 * account that never set one. The caller must treat those two the same way from
 * the outside -- see verifyPassword, which spends the same time on both.
 */
export async function getUserForPassword(email) {
  const [row] = await sql`
    select id, email::text as email, password_hash
    from users where email = ${String(email).trim().toLowerCase()}
  `;
  return row ?? null;
}

export async function setPasswordHash({ userId, hash }) {
  await sql`
    update users set password_hash = ${hash}, password_set_at = now()
    where id = ${userId}
  `;
}

/** Removing it leaves the account reachable by link and passkey, never locked out. */
export async function clearPassword(userId) {
  await sql`
    update users set password_hash = null, password_set_at = null where id = ${userId}
  `;
}

export async function recordLoginAttempt({ email, ok, ip }) {
  await sql`
    insert into login_attempts (email, ok, ip)
    values (${String(email).trim().toLowerCase()}, ${ok}, ${ip ?? null})
  `;
}

/**
 * How many times this address has failed recently.
 *
 * Counted since the last SUCCESS, not over a flat window: signing in correctly is
 * the clearest possible evidence that the person is who they say, so it should not
 * leave them one typo away from a lockout inherited from an attacker.
 */
export async function recentFailedLogins({ email, minutes = 15 }) {
  const [row] = await sql`
    select count(*)::int as n from login_attempts
    where email = ${String(email).trim().toLowerCase()}
      and not ok
      and at > now() - (${`${minutes} minutes`})::interval
      and at > coalesce(
        (select max(at) from login_attempts
          where email = ${String(email).trim().toLowerCase()} and ok),
        'epoch'::timestamptz
      )
  `;
  return row.n;
}

/** This is a log of who tried to get into what, so it is not kept indefinitely. */
export async function pruneLoginAttempts({ days = 30 } = {}) {
  const rows = await sql`
    delete from login_attempts where at < now() - (${`${days} days`})::interval
    returning id
  `;
  return rows.length;
}

export async function insertLoginToken({ tokenHash, email, expiresAt }) {
  await sql`insert into login_tokens ${sql({ token_hash: tokenHash, email, expires_at: expiresAt })}`;
}

/** Spent on first use -- the update is the guard, so a replayed link is inert. */
export async function consumeLoginToken(tokenHash) {
  const [row] = await sql`
    update login_tokens set consumed_at = now()
    where token_hash = ${tokenHash} and consumed_at is null and expires_at > now()
    returning email
  `;
  return row?.email ?? null;
}

export async function startSession({ userId, ttlDays, userAgent }) {
  const [row] = await sql`
    insert into sessions (user_id, expires_at, user_agent)
    values (${userId}, now() + ${`${ttlDays} days`}::interval, ${userAgent ?? null})
    returning id
  `;
  return row.id;
}

export async function getSessionUser(sessionId) {
  const [row] = await sql`
    select u.* from sessions s
    join users u on u.id = s.user_id
    where s.id = ${sessionId} and s.expires_at > now()
  `;
  return row ?? null;
}

export async function endSession(sessionId) {
  await sql`delete from sessions where id = ${sessionId}`;
}

/* ---------------------------------------------------------------- passkeys -- */

export async function insertPasskey({ credentialId, userId, publicKey, counter, transports }) {
  await sql`
    insert into passkeys (credential_id, user_id, public_key, counter, transports)
    values (${credentialId}, ${userId}, ${publicKey}, ${counter}, ${pgArray(transports)}::text[])
    on conflict (credential_id) do update set
      public_key = excluded.public_key,
      counter = excluded.counter,
      transports = excluded.transports
  `;
}

export async function getPasskey(credentialId) {
  const [row] = await sql`select * from passkeys where credential_id = ${credentialId}`;
  return row ?? null;
}

export async function listPasskeys(userId) {
  return sql`select credential_id, transports, created_at, last_used_at from passkeys where user_id = ${userId}`;
}

export async function touchPasskey(credentialId, counter) {
  await sql`update passkeys set counter = ${counter}, last_used_at = now() where credential_id = ${credentialId}`;
}

/* ------------------------------------------------------ profiles & people -- */

/** Handles are the profile URL, so the shape is constrained rather than trusted. */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9_]{1,28}[a-z0-9])$/i;

/**
 * Names we refuse to hand out, because a profile at one of these would shadow a
 * real page or impersonate the site. Checked here rather than in the route so it
 * cannot be bypassed by a second caller later.
 */
const RESERVED_HANDLES = new Set([
  'about',
  'admin',
  'api',
  'calendar',
  'events',
  'feeds',
  'following',
  'health',
  'healthz',
  'help',
  'leagues',
  'login',
  'logout',
  'messages',
  'me',
  'settings',
  'signup',
  'sitemap',
  'sports',
  'staff',
  'support',
  'teams',
  'tipoffwatch',
  'u',
  'watch',
]);

export const handleAvailableShape = (h) =>
  HANDLE_RE.test(h ?? '') && !RESERVED_HANDLES.has(String(h).toLowerCase());

/**
 * Public profiles worth submitting to a search engine.
 *
 * Three filters, and the third is the one that matters. A handle and
 * profile_public are the obvious ones. But an account that has picked a name and
 * done nothing else is a thin page -- no bio, no follows, nothing to read -- and
 * submitting thousands of those is how a site teaches a crawler that most of it is
 * empty. So a profile has to have SOMETHING on it: a bio, a display name, or a
 * relationship with somebody.
 *
 * A profile turned private, or emptied, simply stops appearing here; the sitemap
 * is regenerated per request rather than stored, so removal needs no cleanup.
 */
export async function publicProfiles({ limit = 45000 } = {}) {
  return sql`
    select u.handle, u.created_at
    from users u
    where u.handle is not null
      and u.profile_public
      and (
        u.bio is not null
        or u.display_name is not null
        or exists (select 1 from user_follows f where f.follower_id = u.id or f.followee_id = u.id)
        or exists (select 1 from follows f where f.user_id = u.id)
      )
    order by u.created_at desc
    limit ${limit}
  `;
}

export async function getUserByHandle(handle) {
  const [row] = await sql`
    select id, handle, display_name, bio, profile_public, created_at
    from users where handle = ${handle}
  `;
  return row ?? null;
}

/**
 * Set or change a handle.
 *
 * The unique index is the real guard -- two people claiming the same name in the
 * same instant is a race no read-then-write can close -- so a conflict is caught
 * and reported rather than pre-checked.
 */
export async function updateProfile({ userId, handle, displayName, bio, profilePublic }) {
  try {
    const [row] = await sql`
      update users set
        handle = ${handle ?? null},
        display_name = ${displayName ?? null},
        bio = ${bio ?? null},
        profile_public = ${profilePublic}
      where id = ${userId}
      returning id, handle, display_name, bio, profile_public
    `;
    return { ok: true, user: row };
  } catch (err) {
    if (String(err?.message ?? '').includes('users_handle_key')) {
      return { ok: false, error: 'That handle is taken.' };
    }
    throw err;
  }
}

export async function followUser({ followerId, followeeId }) {
  if (followerId === followeeId) return false;
  await sql`
    insert into user_follows (follower_id, followee_id)
    values (${followerId}, ${followeeId})
    on conflict do nothing
  `;
  return true;
}

export async function unfollowUser({ followerId, followeeId }) {
  await sql`
    delete from user_follows where follower_id = ${followerId} and followee_id = ${followeeId}
  `;
}

export async function isFollowingUser({ followerId, followeeId }) {
  if (!followerId || !followeeId) return false;
  const [row] = await sql`
    select 1 as x from user_follows
    where follower_id = ${followerId} and followee_id = ${followeeId}
  `;
  return Boolean(row);
}

/** Counts for a profile header, in one round trip rather than two. */
/**
 * The three numbers on a profile, counting exactly what the lists below show.
 *
 * The number and the list disagreed once already, in both possible directions. The
 * count used to be a raw row count while the lists dropped anyone without a handle,
 * so a profile followed by somebody who had not picked one read "1 Followers" above
 * the words "Nobody yet."
 *
 * Making the count match by dropping those followers too was the wrong half to
 * change: they are real people who really did follow, and a follower count that
 * silently omits them under-reports the thing it exists to report. So nobody is
 * filtered here for want of a handle, and the lists no longer filter for it either
 * -- a follower without one is shown, just not linked, because there is no page to
 * link to.
 *
 * The block filter stays, and stays only on followers, mirroring followersOf: a
 * viewer who cannot see a follower must not be told one is there.
 *
 * Teams are counted whole rather than capped, because publicFollows caps the chips
 * and needs the real total to say how many it is not showing.
 */
export async function profileCounts(userId, { viewerId = null } = {}) {
  const [row] = await sql`
    select
      (select count(*)::int
         from user_follows f
         join users u on u.id = f.follower_id
        where f.followee_id = ${userId}
          and not exists (
            select 1 from user_blocks b
            where (b.blocker_id = u.id and b.blocked_id = ${viewerId}::uuid)
               or (b.blocker_id = ${viewerId}::uuid and b.blocked_id = u.id)
          )) as followers,
      (select count(*)::int
         from user_follows f
        where f.follower_id = ${userId}) as following,
      (select count(*)::int from follows where user_id = ${userId}) as teams
  `;
  return row;
}

/**
 * The people following someone, minus anyone either party has blocked.
 *
 * A blocked account must not be able to see itself listed on the blocker's profile
 * and must not appear on it either, so the filter runs in both directions.
 */
export async function followersOf({ userId, viewerId = null, limit = 100, offset = 0 }) {
  return sql`
    select u.id, u.handle, u.display_name, u.profile_public
    from user_follows f
    join users u on u.id = f.follower_id
    where f.followee_id = ${userId}
      and not exists (
        select 1 from user_blocks b
        where (b.blocker_id = u.id and b.blocked_id = ${viewerId}::uuid)
           or (b.blocker_id = ${viewerId}::uuid and b.blocked_id = u.id)
      )
    order by f.created_at desc, u.id
    limit ${Math.min(Math.max(Number(limit) || 100, 1), 200)}
    offset ${Math.max(Number(offset) || 0, 0)}
  `;
}

export async function followingBy({ userId, limit = 100, offset = 0 }) {
  return sql`
    select u.id, u.handle, u.display_name, u.profile_public
    from user_follows f
    join users u on u.id = f.followee_id
    where f.follower_id = ${userId}
    order by f.created_at desc, u.id
    limit ${Math.min(Math.max(Number(limit) || 100, 1), 200)}
    offset ${Math.max(Number(offset) || 0, 0)}
  `;
}

/* --------------------------------------------------------------- blocking -- */

export async function blockUser({ blockerId, blockedId }) {
  if (blockerId === blockedId) return;
  await sql`
    insert into user_blocks (blocker_id, blocked_id) values (${blockerId}, ${blockedId})
    on conflict do nothing
  `;
  // A block ends the relationship in both directions. Leaving the follow in place
  // means the blocked account keeps receiving the blocker in its feed, which is
  // exactly what the block was for.
  await sql`
    delete from user_follows
    where (follower_id = ${blockerId} and followee_id = ${blockedId})
       or (follower_id = ${blockedId} and followee_id = ${blockerId})
  `;
}

export async function unblockUser({ blockerId, blockedId }) {
  await sql`delete from user_blocks where blocker_id = ${blockerId} and blocked_id = ${blockedId}`;
}

/** Either direction: a block stops the conversation both ways, not just inbound. */
export async function blockExists({ a, b }) {
  const [row] = await sql`
    select 1 as x from user_blocks
    where (blocker_id = ${a} and blocked_id = ${b}) or (blocker_id = ${b} and blocked_id = ${a})
  `;
  return Boolean(row);
}

/* --------------------------------------------------------------- messages -- */

/**
 * How many messages this account has sent in the last hour.
 *
 * The cheapest useful spam brake: a new account cannot open a hundred
 * conversations before anyone notices. Counted per sender rather than per pair,
 * because the abuse worth stopping is breadth, not depth.
 */
export async function messagesSentSince({ senderId, minutes = 60 }) {
  const [row] = await sql`
    select count(*)::int as n from messages
    where sender_id = ${senderId} and created_at > now() - (${minutes} || ' minutes')::interval
  `;
  return row.n;
}

export async function sendMessage({ senderId, recipientId, body }) {
  const [row] = await sql`
    insert into messages (sender_id, recipient_id, body)
    values (${senderId}, ${recipientId}, ${body})
    returning id, sender_id, recipient_id, body, created_at
  `;
  return row;
}

/**
 * One conversation, oldest last.
 *
 * Both orderings of the pair, because a thread is the union of what each person
 * sent. Reading it also marks the viewer's half as read, which is done in the same
 * round trip rather than as a second call nobody remembers to make.
 */
export async function thread({ userId, otherId, limit = 200 }) {
  const rows = await sql`
    select id, sender_id, recipient_id, body, created_at, read_at
    from messages
    where (sender_id = ${userId} and recipient_id = ${otherId})
       or (sender_id = ${otherId} and recipient_id = ${userId})
    order by created_at desc
    limit ${Math.min(Math.max(Number(limit) || 200, 1), 500)}
  `;
  await sql`
    update messages set read_at = now()
    where recipient_id = ${userId} and sender_id = ${otherId} and read_at is null
  `;
  return rows.reverse();
}

/**
 * The inbox: one row per correspondent, with the latest message.
 *
 * distinct on is the right tool and the reason the order by starts with the same
 * expression it distinguishes on -- Postgres requires that, and getting it wrong
 * returns an arbitrary message per thread rather than the newest.
 */
export async function conversations({ userId, limit = 50 }) {
  return sql`
    select distinct on (other_id)
      other_id, u.handle, u.display_name, m.body, m.created_at,
      (m.recipient_id = ${userId} and m.read_at is null) as unread,
      m.sender_id = ${userId} as outgoing
    from (
      select *,
             case when sender_id = ${userId} then recipient_id else sender_id end as other_id
      from messages
      where sender_id = ${userId} or recipient_id = ${userId}
    ) m
    join users u on u.id = m.other_id
    order by other_id, m.created_at desc
    limit ${Math.min(Math.max(Number(limit) || 50, 1), 200)}
  `;
}

export async function unreadMessageCount(userId) {
  if (!userId) return 0;
  const [row] = await sql`
    select count(*)::int as n from messages where recipient_id = ${userId} and read_at is null
  `;
  return row.n;
}

/**
 * One of the reader's own channels, by id.
 *
 * Scoped through the playlist join like every other read of this table, so an id
 * from anywhere else returns nothing rather than somebody else's row.
 *
 * Exists because the ranked lists on a fixture page are addressed by INDEX, and
 * an index only means something inside one ranked list. The broadcaster listings
 * are a different arrangement of the same channels -- by country, in the order a
 * provider gave them -- so they need a stable handle, and the row id is the only
 * one there is.
 */
export async function ownChannelById(userId, channelId) {
  const [row] = await sql`
    select c.id, c.title, c.group_title, c.kind, c.stream_url, c.is_live, c.checked_at
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId} and c.id = ${channelId}
  `;
  return row ?? null;
}

/**
 * Record what a probe saw.
 *
 * Scoped by user as well as by channel id, so an id from anywhere else cannot
 * write a verdict into somebody else's list.
 */
export async function markChannelChecked({ userId, channelId, live, note }) {
  await sql`
    update user_playlist_channels c set
      is_live = ${live},
      checked_at = now(),
      check_note = ${String(note ?? '').slice(0, 200)}
    from user_playlists p
    where c.playlist_id = p.id
      and p.user_id = ${userId}
      and c.id = ${channelId}
  `;
}

/* ---------------------------------------------------------- own playlists -- */

/**
 * Every query here takes a user_id and uses it, without exception.
 *
 * That is the whole security model for this feature: a channel list is one
 * person's own subscription, and there must be no query that can return another
 * account's rows even by mistake. A `getPlaylistById` taking only an id is exactly
 * the shape that leaks it later, so it does not exist -- ownership is part of the
 * lookup rather than something a caller is trusted to remember.
 */

/** One list per account: adding a second replaces the first. */
export async function savePlaylist({ userId, label, sourceUrl }) {
  const [row] = await sql`
    insert into user_playlists (user_id, label, source_url)
    values (${userId}, ${label ?? null}, ${sourceUrl})
    on conflict (user_id) do update set
      label = excluded.label,
      source_url = excluded.source_url,
      last_error = null
    returning id, user_id, label, channel_count, last_synced_at, last_error, created_at
  `;
  return row;
}

export async function getPlaylist(userId) {
  const [row] = await sql`select * from user_playlists where user_id = ${userId}`;
  return row ?? null;
}

export async function deletePlaylist(userId) {
  await sql`delete from user_playlists where user_id = ${userId}`;
}

/* ----------------------------------------------------- sharing a playlist -- */
/**
 * Record a probe verdict on a SHARED entry.
 *
 * Deliberately not scoped by a viewer, and that is the difference from
 * markChannelChecked. Whether a slot is streaming is a fact about the owner's
 * line, not about who asked -- so a check run by any reader benefits everyone,
 * including the owner. `p.shared` is what makes the write legitimate: a row stops
 * being writable this way the moment its owner closes the list.
 */
export async function markSharedChannelChecked({ channelId, live, note }) {
  await sql`
    update user_playlist_channels c set
      is_live = ${live === null ? null : Boolean(live)},
      checked_at = now(),
      check_note = ${note ? String(note).slice(0, 200) : null}
    from user_playlists p
    where c.id = ${channelId} and p.id = c.playlist_id and p.shared
  `;
}

/**
 * Open one account's list to everybody signed in, or close it again.
 *
 * Owner-only by construction: the update is keyed on user_id, so there is no id a
 * caller could pass to open somebody else's list.
 *
 * `shared_at` is stamped on the transition rather than on every save, so a page
 * can say how long a list has been open rather than only that it is. Turning it
 * off leaves the timestamp alone -- it is a record of when this started, and a
 * flag that is currently false makes the distinction unambiguous.
 */
export async function setPlaylistShared({ userId, shared, label = null }) {
  const [row] = await sql`
    update user_playlists set
      shared = ${Boolean(shared)},
      shared_at = case
        when ${Boolean(shared)} and not shared then now()
        else shared_at
      end,
      -- Null clears it, which is the difference between "no label" and "do not
      -- change the label". The caller decides by passing one or not.
      shared_label = ${label === null ? null : String(label).slice(0, 80)}
    where user_id = ${userId}
    returning shared, shared_at, shared_label
  `;
  return row ?? null;
}

/**
 * Every channel on every list whose owner has opened it.
 *
 * The one query in this file that deliberately crosses accounts, and the only
 * one. Everything else about this table is scoped through the playlist join to
 * the account that supplied it; this reads other people's rows, so the predicate
 * that makes it legitimate -- `p.shared` -- is the first thing in the where
 * clause rather than buried in it.
 *
 * What comes back carries the OWNER's id, and that is load-bearing rather than
 * informational: the connection ceiling is a property of the owner's line, not of
 * whoever is watching, so every caller counts slots against `owner_id`. Counting
 * against the viewer would let twenty readers open twenty connections on one
 * subscription, which is how that subscription gets terminated.
 *
 * The reader's own list is excluded -- it is already the first section on the
 * page, and a channel appearing in both reads as a duplicate rather than as two
 * facts.
 */
export async function sharedPlaylistChannels({ viewerId = null, limit = 20000 } = {}) {
  return sql`
    select c.id, c.title, c.group_title, c.kind, c.stream_url, c.norm_title,
           c.is_live, c.checked_at,
           p.user_id as owner_id,
           coalesce(p.shared_label, u.display_name, '@' || u.handle::text, 'someone') as owner_label
    from user_playlists p
    join users u on u.id = p.user_id
    join user_playlist_channels c on c.playlist_id = p.id
    where p.shared
      and (${viewerId}::uuid is null or p.user_id <> ${viewerId})
      -- Same freshness rule as a reader's own list: a "dead" verdict is respected
      -- only while it is recent, and NULL is never filtered out because unchecked
      -- is not the same as dead.
      and (c.is_live is not false or c.checked_at < now() - interval '30 minutes')
    order by c.position
    limit ${limit}
  `;
}

/** Whose lists are open, for the page that says so. Never includes a URL. */
export async function sharedPlaylistOwners() {
  return sql`
    select p.user_id as owner_id,
           u.handle::text as handle,
           coalesce(p.shared_label, u.display_name, '@' || u.handle::text, 'someone') as label,
           p.channel_count, p.shared_at, p.last_synced_at
    from user_playlists p
    join users u on u.id = p.user_id
    where p.shared
    order by p.channel_count desc nulls last, p.shared_at
  `;
}

/**
 * One shared channel by its own id, with the owner beside it.
 *
 * Used by the routes that play a shared entry. Keyed by the channel id alone --
 * there is no viewer to scope by, which is the whole point of the feature -- so
 * `p.shared` is what authorises the read and it is checked here rather than by
 * the caller remembering to.
 */
export async function sharedChannelById(channelId) {
  const [row] = await sql`
    select c.id, c.title, c.group_title, c.kind, c.stream_url,
           p.user_id as owner_id,
           coalesce(p.shared_label, u.display_name, '@' || u.handle::text, 'someone') as owner_label
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    join users u on u.id = p.user_id
    where c.id = ${channelId} and p.shared
  `;
  return row ?? null;
}

/**
 * Record a failure and back off.
 *
 * Exponential on the streak, capped at an hour. A provider that is down, or a line
 * that has expired, must not be pulled for 800KB every five minutes -- that is both
 * pointless and the sort of traffic that gets the account behind it noticed.
 */
export async function markPlaylistError({ userId, error }) {
  await sql`
    update user_playlists set
      last_error = ${String(error).slice(0, 300)},
      last_synced_at = now(),
      error_streak = least(error_streak + 1, 8),
      refresh_after = now() + (least(power(2, least(error_streak + 1, 6))::int, 60) || ' minutes')::interval
    where user_id = ${userId}
  `;
}

/** A successful poll, whether or not the content had actually changed. */
export async function markPlaylistFresh({ userId, contentHash, nextAt }) {
  await sql`
    update user_playlists set
      last_synced_at = now(),
      last_error = null,
      error_streak = 0,
      content_hash = ${contentHash},
      refresh_after = ${nextAt}
    where user_id = ${userId}
  `;
}

/**
 * Lists due for a poll.
 *
 * `refresh_after is null` covers a list added before this column existed and one
 * added a moment ago, both of which should be picked up on the next tick. Ordered
 * oldest-first so a backlog drains fairly rather than starving whoever sorts last.
 */
/**
 * When the next list becomes due, for the idle log line.
 *
 * Cheap and answers the question the logs could not: an idle poller and an
 * unregistered one both printed nothing, so "is the refresh running" was
 * unanswerable without this.
 */
export async function nextPlaylistRefreshAt() {
  return sql`
    select min(coalesce(refresh_after, now())) as next_at,
           count(*)::int as lists
    from user_playlists
  `;
}

export async function playlistsDueForRefresh({ limit = 25 } = {}) {
  return sql`
    select user_id, source_url, label, content_hash
    from user_playlists
    where refresh_after is null or refresh_after <= now()
    order by refresh_after nulls first, last_synced_at nulls first
    limit ${Math.min(Math.max(Number(limit) || 25, 1), 200)}
  `;
}

/**
 * Replace a list's channels wholesale.
 *
 * Delete-then-insert rather than a diff: a provider rewrites its numbered event
 * slots constantly, so almost every row changes on every refresh and a diff would
 * be more work for the same answer. Both statements run in one transaction so a
 * failed import cannot leave the reader holding half a list.
 */
export async function replacePlaylistChannels({ userId, channels }) {
  return sql.begin(async (tx) => {
    const [pl] = await tx`select id from user_playlists where user_id = ${userId}`;
    if (!pl) return 0;

    await tx`delete from user_playlist_channels where playlist_id = ${pl.id}`;

    // Chunked because a real list is thousands of rows, and one statement per row
    // would be thousands of round trips.
    const CHUNK = 500;
    for (let i = 0; i < channels.length; i += CHUNK) {
      const slice = channels.slice(i, i + CHUNK).map((c, n) => ({
        playlist_id: pl.id,
        position: i + n,
        title: c.title,
        group_title: c.groupTitle ?? null,
        kind: c.kind ?? null,
        stream_url: c.streamUrl,
        norm_title: c.normTitle,
      }));
      if (slice.length) await tx`insert into user_playlist_channels ${tx(slice)}`;
    }

    await tx`
      update user_playlists
         set channel_count = ${channels.length}, last_synced_at = now(), last_error = null
       where id = ${pl.id}
    `;
    return channels.length;
  });
}

/**
 * The reader's own channels, for matching against a fixture.
 *
 * Joined through user_playlists on user_id, so ownership is enforced by the
 * statement rather than by the caller remembering to check it.
 */
export async function playlistChannels(userId, { limit = 20000 } = {}) {
  return sql`
    select c.id, c.title, c.group_title, c.kind, c.stream_url, c.norm_title,
           c.is_live, c.checked_at
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId}
      -- A verdict of "dead" is respected only while it is fresh. The provider
      -- rewrites its event slots around kickoff, so a slot that was empty an
      -- hour ago is exactly the one that fills when the game starts. NULL is
      -- never filtered out: unchecked is not the same as dead.
      and (c.is_live is not false or c.checked_at < now() - interval '30 minutes')
    order by c.position
    limit ${limit}
  `;
}

/* --------------------------------------------------------------- catalogue -- */

/**
 * Upsert from the catalogue endpoint.
 *
 * Note what is NOT updated: name, abbreviation and logo. The catalogue only knows a
 * league's slug, so it seeds those on insert and must never touch them again --
 * otherwise the daily catalogue sync overwrites "English Premier League" with
 * "eng.1" every night. The scoreboard is the authority for display metadata; see
 * renameLeague.
 */
export async function upsertLeague(league) {
  const [row] = await sql`
    insert into leagues ${sql(league)}
    on conflict (provider, provider_key) do update set
      sport = excluded.sport,
      active = true
    returning *
  `;
  return row;
}

/**
 * How many leagues are still named after their raw slug.
 *
 * A non-zero count means display names have never been backfilled from the
 * scoreboard, which is a reason to sync even when the fixtures themselves are
 * fresh -- otherwise the site shows "eng.1" until something else happens to
 * trigger a sweep.
 */
export async function leaguesMissingRealName() {
  const [row] = await sql`
    select count(*)::int as n from leagues
    where active and name = split_part(provider_key, '/', 2)
  `;
  return row.n;
}

export async function upsertTeams(teams) {
  if (teams.length === 0) return [];
  return sql`
    insert into teams ${sql(teams)}
    on conflict (provider, provider_key) do update set
      name = excluded.name,
      display_name = excluded.display_name,
      abbreviation = excluded.abbreviation,
      logo_url = coalesce(excluded.logo_url, teams.logo_url)
    returning id, provider_key
  `;
}

/**
 * Bulk upsert in one statement. A sync touches hundreds of rows per league and the
 * cost is round trips, not rows -- one multi-row insert beats a loop by an order of
 * magnitude, and keeps the whole league's schedule atomically consistent.
 */
export async function upsertEvents(events) {
  if (events.length === 0) return [];
  return sql`
    insert into events ${sql(events)}
    on conflict (provider, provider_key) do update set
      starts_at = excluded.starts_at,
      -- Carried on update, not just insert: a provider that pins down a TBD
      -- kickoff must be able to turn this back on, and one that postpones a
      -- fixture to "date TBA" must be able to turn it off.
      time_known = excluded.time_known,
      precision = excluded.precision,
      state = excluded.state,
      status_detail = excluded.status_detail,
      name = excluded.name,
      short_name = excluded.short_name,
      venue = coalesce(excluded.venue, events.venue),
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      -- Must be updated, not just set on insert. Rebuilding the team rows leaves
      -- existing fixtures pointing at nothing, and without this they stay that way
      -- forever: the league page falls back to the provider's own title string and
      -- looks fine, while every team reports "no fixtures scheduled" and each team
      -- page is empty. coalesce so a provider omitting a side (individual sports)
      -- cannot wipe a reference we already resolved.
      home_team_id = coalesce(excluded.home_team_id, events.home_team_id),
      away_team_id = coalesce(excluded.away_team_id, events.away_team_id),
      venue_city = coalesce(excluded.venue_city, events.venue_city),
      venue_region = coalesce(excluded.venue_region, events.venue_region),
      -- Not coalesced: a fixture moved to or from a neutral ground must be able to
      -- go back to false, and false is a real value rather than an absent one.
      neutral_site = excluded.neutral_site,
      -- ESPN wins whenever it actually has a listing: it is the more precise
      -- source for the US leagues it covers, and it is the one that fills in
      -- late as kickoff approaches. Its NULL must not wipe a value the fallback
      -- pass found, which is what the coalesce is for -- and the provenance
      -- columns have to move WITH the value or a row ends up labelled with the
      -- market of a listing it no longer holds.
      broadcast = coalesce(excluded.broadcast, events.broadcast),
      broadcast_source =
        case when excluded.broadcast is not null then 'espn' else events.broadcast_source end,
      broadcast_country =
        case when excluded.broadcast is not null then 'United States' else events.broadcast_country end,
      broadcast_markets =
        case when excluded.broadcast is not null
             then excluded.broadcast_markets else events.broadcast_markets end,
      attendance = coalesce(excluded.attendance, events.attendance),
      period = excluded.period,
      display_clock = excluded.display_clock,
      home_record = coalesce(excluded.home_record, events.home_record),
      away_record = coalesce(excluded.away_record, events.away_record),
      updated_at = now()
    returning id, provider_key
  `;
}

/**
 * Leagues with a fixture in a given window.
 *
 * The lever the whole near-window refresh turns on. Measured against production on
 * 2026-08-21: of 359 active leagues, 48 had a fixture today and 74 within 48 hours
 * -- so asking only these costs a fifth of a full sweep, and the four fifths it
 * skips are competitions that are out of season or not playing until next week.
 *
 * Distinct on the league, not the fixture: one request answers a whole league's
 * window, so a league with nine games today is still one row here.
 */
export async function leaguesWithFixturesBetween({ from, to }) {
  return sql`
    select distinct l.*
    from leagues l
    join events e on e.league_id = l.id
    where l.active
      and e.starts_at >= ${from}
      and e.starts_at < ${to}
    order by l.priority, l.name
  `;
}

/**
 * Fixtures the fallback pass should look at.
 *
 * Two groups, and the second is easy to forget. The obvious one is fixtures with
 * no broadcaster at all. The other is fixtures WE filled previously: a row written
 * while the shared key was truncating carries a single channel and a single
 * market, and it would keep that thin answer forever, because "missing" was read
 * as "null" and the row is not null. Buying a subscriber key changed what a good
 * answer looks like; rows already written have to be allowed to catch up.
 *
 * ESPN's listings are never in scope. broadcast_source = 'espn' is the more precise
 * answer wherever it exists and this pass must not reopen it.
 *
 * Both sides are required. A fixture with an unresolved team cannot be matched
 * against a listing titled "Home vs Away", so fetching it would only waste a
 * request; individual sports (tennis, golf, racing) fall out here for that reason.
 */
export async function listEventsMissingBroadcast({ from, to, limit = 500 }) {
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  return sql`
    select e.id, e.starts_at, l.sport,
           ht.display_name as home_name, at.display_name as away_name
    from events e
    join leagues l on l.id = e.league_id
    join teams ht on ht.id = e.home_team_id
    join teams at on at.id = e.away_team_id
    where (e.broadcast is null or e.broadcast_source = 'thesportsdb')
      and e.starts_at >= ${from}
      and e.starts_at < ${to}
    order by e.starts_at
    limit ${cap}
  `;
}

/**
 * Write listings found by the fallback pass.
 *
 * Guarded by `broadcast is null` in the statement itself, not just in the query
 * that built the work list. The pass fetches over the network between the two, and
 * a live tick landing an ESPN listing in that gap is the expected case rather than
 * a race worth ignoring -- ESPN is the better source when it has an answer, so the
 * writer that would downgrade it declines instead.
 *
 * @param {Array<{id:number, broadcast:string, country:string|null}>} rows
 */
export async function fillMissingBroadcasts(rows) {
  if (rows.length === 0) return [];
  return sql`
    update events e set
      broadcast = v.broadcast,
      broadcast_source = 'thesportsdb',
      broadcast_country = v.country,
      broadcast_markets = v.markets::jsonb,
      updated_at = now()
    from (
      select * from unnest(
        ${pgArray(rows.map((r) => r.id))}::bigint[],
        ${pgArray(rows.map((r) => r.broadcast))}::text[],
        ${pgArray(rows.map((r) => r.country ?? null))}::text[],
        -- Serialised here rather than bound as an object: these go through the
        -- same text[] unnest as everything else, and Bun's client flattens a JS
        -- array with Array.prototype.toString rather than into a Postgres literal.
        ${pgArray(rows.map((r) => JSON.stringify(r.markets ?? [])))}::text[]
      ) as t(id, broadcast, country, markets)
    ) v
    -- Null, or a previous answer from this same pass. Never ESPN's: that guard is
    -- the reason a live tick landing a US listing mid-run cannot be undone here.
    where e.id = v.id and (e.broadcast is null or e.broadcast_source = 'thesportsdb')
    returning e.id
  `;
}

export async function listLeagues({ sport = null, limit = 500 } = {}) {
  if (sport) {
    return sql`select * from leagues where active and sport = ${sport} order by priority, name limit ${limit}`;
  }
  return sql`select * from leagues where active order by priority, name limit ${limit}`;
}

export async function listSports() {
  return sql`select sport, count(*)::int as leagues from leagues where active group by sport order by sport`;
}

/** Trigram search over team names, for the follow picker. */
export async function searchTeams(term, limit = 25) {
  return sql`
    select t.id, t.slug, t.display_name, t.logo_url, l.name as league_name, l.abbreviation as league_abbr, l.sport
    from teams t left join leagues l on l.id = t.league_id
    where t.display_name ilike ${`%${term}%`}
    order by similarity(t.display_name, ${term}) desc
    limit ${limit}
  `;
}

/* ------------------------------------------------------------------ search -- */

/**
 * Collections whose name looks like what was typed.
 *
 * Matched on the name AND the abbreviation, because half of what people type is
 * the abbreviation -- "EPL", "NCAAM", "MLS" -- and a trigram over the full name
 * scores those close to zero.
 *
 * A few hundred rows, so no index and none wanted.
 */
export async function searchLeagues(term, { limit = 8, sport = null } = {}) {
  const q = String(term ?? '')
    .trim()
    .toLowerCase();
  if (q.length < 2) return [];

  return sql`
    select l.id, l.slug, l.name, l.abbreviation, l.sport, l.logo_url,
           (select count(*) from events e
             where e.league_id = l.id and e.starts_at > now())::int as upcoming
    from leagues l
    where l.active
      and (${sport}::text is null or l.sport = ${sport})
      and (lower(l.name) % ${q}
           or lower(l.name) like ${`%${q}%`}
           or lower(coalesce(l.abbreviation, '')) = ${q})
    order by
      -- An exact abbreviation is what somebody typing four capital letters meant,
      -- and it must not be outranked by a long name that happens to share trigrams.
      (lower(coalesce(l.abbreviation, '')) = ${q}) desc,
      similarity(lower(l.name), ${q}) desc,
      l.priority,
      l.name
    limit ${limit}
  `;
}

/**
 * Participants, with enough context to tell two of them apart.
 *
 * searchTeams above is the follow picker's query and stays as it is: it is called
 * on every keystroke and returns the least it can. This one is for the results
 * page, so it carries the collection, the sport and the next fixture -- which is
 * the difference between "Denver Broncos" and "Denver Broncos, NFL, Sunday".
 *
 * Team ids are unique only within a league, and several sports have two clubs of
 * the same name in different competitions, so the league is not decoration here.
 */
export async function searchTeamsFull(term, { limit = 20, sport = null } = {}) {
  const q = String(term ?? '').trim();
  if (q.length < 2) return [];

  return sql`
    select t.id, t.slug, t.display_name, t.abbreviation, t.logo_url,
           l.name as league_name, l.abbreviation as league_abbr, l.slug as league_slug, l.sport,
           (select e.id from events e
             where (e.home_team_id = t.id or e.away_team_id = t.id) and e.starts_at > now()
             order by e.starts_at limit 1) as next_event_id,
           (select e.starts_at from events e
             where (e.home_team_id = t.id or e.away_team_id = t.id) and e.starts_at > now()
             order by e.starts_at limit 1) as next_starts_at
    from teams t
    left join leagues l on l.id = t.league_id
    where t.display_name ilike ${`%${q}%`}
      and (${sport}::text is null or l.sport = ${sport})
    order by similarity(t.display_name, ${q}) desc, length(t.display_name), t.display_name
    limit ${limit}
  `;
}

/**
 * Fixtures by their own name.
 *
 * Most fixtures are called "X at Y" and are already reachable through either
 * side, so this exists for the ones that are not: a cup final, a title fight, a
 * race meeting, anything with a name of its own.
 *
 * Ordered by distance from now in either direction, not by date. For a club with
 * a decade of history the interesting rows are the next one and the last one, and
 * a plain date sort gives you one end or the other but never both.
 */
export async function searchFixtures(term, { limit = 10, sport = null } = {}) {
  const q = String(term ?? '')
    .trim()
    .toLowerCase();
  if (q.length < 2) return [];

  return sql`
    select e.id, e.name, e.short_name, e.starts_at, e.state, e.venue,
           l.name as league_name, l.abbreviation as league_abbr, l.slug as league_slug, l.sport,
           ht.display_name as home_name, at.display_name as away_name
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where (${sport}::text is null or l.sport = ${sport})
      and (lower(e.name) like ${`%${q}%`} or lower(coalesce(e.short_name, '')) like ${`%${q}%`})
      -- Both sides are already their own section on the results page. Without
      -- this, searching a club name returns the club and then its whole season,
      -- which pushes every other kind of answer off the screen.
      and coalesce(lower(ht.display_name), '') not like ${`%${q}%`}
      and coalesce(lower(at.display_name), '') not like ${`%${q}%`}
    order by abs(extract(epoch from (e.starts_at - now()))), e.starts_at desc
    limit ${limit}
  `;
}

/**
 * A reader's own channel list.
 *
 * The one search that is not about our catalogue at all: somebody with a
 * subscription is asking whether THEY have it, and until now the only way to find
 * out was to open a fixture we happened to hold and read the panel on its page.
 *
 * `normTerm` is pre-normalised by the caller. norm_title is written by the m3u
 * parser's normaliseTitle at import, and the needle has to go through the same
 * function or the two disagree about punctuation -- but this module cannot import
 * that package, because that package imports this one.
 *
 * Scoped through the playlist join like every other read of this table, and the
 * stream URL is deliberately not selected: it is a credential, and it belongs to
 * the download and proxy routes rather than to a search result.
 */
export async function searchOwnChannels(userId, { normTerm, limit = 12 } = {}) {
  const needle = String(normTerm ?? '').trim();
  if (!userId || needle.length < 2) return [];

  return sql`
    select c.id, c.title, c.group_title, c.is_live, c.checked_at
    from user_playlist_channels c
    join user_playlists p on p.id = c.playlist_id
    where p.user_id = ${userId}
      and c.norm_title like ${`%${needle}%`}
    -- A slot known to be dead sinks; unchecked stays put, because unchecked is not
    -- the same as dead. Then the plainest title, which is the primary rather than
    -- a regional alternate or a replay with a date baked into its name.
    order by (c.is_live is false), length(c.title), c.position
    limit ${limit}
  `;
}

/**
 * People, by handle or by the name they chose.
 *
 * Only public profiles, and only accounts that picked a handle: an account
 * without one has no page to link to, and profile_public is an explicit opt-out
 * that has to be honoured everywhere something is listed.
 *
 * A blocked account is filtered out for the viewer who blocked it -- appearing in
 * their search results is exactly the thing blocking is for.
 */
export async function searchPeople(term, { limit = 6, viewerId = null } = {}) {
  const q = String(term ?? '').trim();
  if (q.length < 2) return [];
  const like = `%${q}%`;

  return sql`
    select u.handle::text as handle, u.display_name
    from users u
    where u.handle is not null
      and u.profile_public
      and (u.handle::text ilike ${like} or u.display_name ilike ${like})
      and not exists (
        select 1 from user_blocks b
        where b.blocker_id = ${viewerId} and b.blocked_id = u.id
      )
    order by (u.handle::text ilike ${q}) desc, u.handle::text
    limit ${limit}
  `;
}

/**
 * What starts in the next few hours.
 *
 * The category page had "live now" and nothing between that and a whole day's
 * schedule, so the most useful state of all -- about to start, still time to find
 * a stream or sit down -- had no home. `state = 'pre'` and a window, ordered by
 * time rather than by league: at this range the clock is what matters, and a
 * kickoff in ten minutes in a small competition beats one in three hours in a big
 * one.
 *
 * Deliberately excludes anything already under way. That list is directly above
 * this one, and a fixture appearing in both reads as a duplicate rather than as
 * two facts.
 */
export async function startingSoon({ hours = 4, limit = 30, viewerId = null } = {}) {
  return sql`
    select e.*, l.name as league_name, l.abbreviation as league_abbr, l.slug as league_slug, l.sport,
           exists (
             select 1 from follows vf
             where vf.user_id = ${viewerId}
               and (
                 (vf.subject_type = 'team' and vf.subject_id in (e.home_team_id, e.away_team_id))
                 or (vf.subject_type = 'league' and vf.subject_id = e.league_id)
               )
           ) as following,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.state = 'pre'
      -- A date we padded to noon UTC is not a thing that "starts in two hours".
      -- Every brand running this code stores those (a release with only a month,
      -- a launch window with only a day), and counting down to an hour nobody
      -- chose is the one mistake this column exists to prevent.
      and e.time_known
      and e.starts_at > now()
      and e.starts_at <= now() + (${hours} * interval '1 hour')
    order by e.starts_at, l.priority
    limit ${limit}
  `;
}

/** How many start inside the window, whether or not they all fit in the list. */
export async function startingSoonCount({ hours = 4 } = {}) {
  const [row] = await sql`
    select count(*)::int as n from events
    where state = 'pre'
      and time_known
      and starts_at > now()
      and starts_at <= now() + (${hours} * interval '1 hour')
  `;
  return row?.n ?? 0;
}

/* ----------------------------------------------------------------- follows -- */

export async function addFollow({ userId, subjectType, subjectId }) {
  await sql`
    insert into follows ${sql({ user_id: userId, subject_type: subjectType, subject_id: subjectId })}
    on conflict do nothing
  `;
}

/**
 * Follow every active league in one statement.
 *
 * insert-select rather than a loop: it is 359 rows, and the cost of doing it a row
 * at a time is 359 round trips for something a single statement expresses exactly.
 * `on conflict do nothing` makes it idempotent, so a second click adds whatever
 * leagues appeared since the first and nothing else.
 *
 * Returns how many were NEW, which is what the page reports back -- "followed 359"
 * when nothing changed would be a lie to anyone pressing it twice.
 */
export async function followAllLeagues(userId) {
  const rows = await sql`
    insert into follows (user_id, subject_type, subject_id)
    select ${userId}, 'league', l.id from leagues l where l.active
    on conflict do nothing
    returning subject_id
  `;
  return rows.length;
}

/**
 * Clear the whole follow list -- teams as well as leagues.
 *
 * Deliberately NOT the same thing as unfollowAllLeagues. That one is the undo for
 * the follow-everything button, and it spares team follows because they were chosen
 * one at a time. This one backs the "Unfollow everything" control on My games, where
 * the list being cleared is the one in front of you: leaving the teams behind there
 * would be the surprise, not the safeguard.
 *
 * Returns the counts by kind, because "removed 40" tells someone who is about to
 * wonder whether their teams survived exactly nothing.
 */
export async function unfollowAll(userId) {
  const rows = await sql`
    delete from follows where user_id = ${userId}
    returning subject_type
  `;
  return {
    removed: rows.length,
    leagues: rows.filter((r) => r.subject_type === 'league').length,
    teams: rows.filter((r) => r.subject_type === 'team').length,
  };
}

/** The undo. Only leagues: a team follow was chosen one at a time and is left alone. */
export async function unfollowAllLeagues(userId) {
  const rows = await sql`
    delete from follows where user_id = ${userId} and subject_type = 'league'
    returning subject_id
  `;
  return rows.length;
}

/** How many leagues this person follows, and how many there are. */
export async function leagueFollowCounts(userId) {
  const [row] = await sql`
    select
      (select count(*)::int from leagues where active) as total,
      (select count(*)::int from follows
        where user_id = ${userId}::uuid and subject_type = 'league') as following
  `;
  return row;
}

/**
 * How many fixtures a "follow everything" actually signs someone up for.
 *
 * Shown before they press it, because the honest number is large: every upcoming
 * game in the catalogue, each of which sends a reminder at every offset they have
 * turned on. A button that quietly enrols someone in thousands of notifications is
 * not a feature.
 */
export async function upcomingEventCount() {
  const [row] = await sql`
    select count(*)::int as n from events
    where starts_at > now() and starts_at < now() + interval '14 days'
  `;
  return row.n;
}

export async function removeFollow({ userId, subjectType, subjectId }) {
  await sql`delete from follows where user_id = ${userId} and subject_type = ${subjectType} and subject_id = ${subjectId}`;
}

/**
 * Everything a user follows, teams and competitions together.
 *
 * `slug` is selected so a caller can link each row to the thing it names. The
 * private list on /following does not use it -- every chip there is an unfollow
 * control rather than a link -- but a public profile has nothing to offer but
 * the link.
 */
export async function listFollows(userId) {
  return sql`
    select f.subject_type, f.subject_id,
           coalesce(t.display_name, l.name) as label,
           coalesce(t.slug, l.slug) as slug,
           coalesce(t.logo_url, l.logo_url) as logo_url,
           coalesce(tl.sport, l.sport) as sport
    from follows f
    left join teams t on f.subject_type = 'team' and t.id = f.subject_id
    left join leagues tl on tl.id = t.league_id
    left join leagues l on f.subject_type = 'league' and l.id = f.subject_id
    where f.user_id = ${userId}
    order by label
  `;
}

/**
 * The same list, capped, for somebody else's profile.
 *
 * Capped rather than complete because "follow everything" is one button on
 * /sports: a page rendering every row would print 359 chips for anyone who
 * pressed it. The caller already has the true total from profileCounts and says
 * how many are not shown, so the cap never reads as the whole story.
 *
 * Teams sort first. Someone who picked a handful of clubs and then took the whole
 * catalogue would otherwise have those clubs buried alphabetically among hundreds
 * of competitions they never chose one at a time.
 */
export async function publicFollows(userId, { limit = 60 } = {}) {
  return sql`
    select f.subject_type, f.subject_id,
           coalesce(t.display_name, l.name) as label,
           coalesce(t.slug, l.slug) as slug,
           coalesce(t.logo_url, l.logo_url) as logo_url,
           coalesce(tl.sport, l.sport) as sport
    from follows f
    left join teams t on f.subject_type = 'team' and t.id = f.subject_id
    left join leagues tl on tl.id = t.league_id
    left join leagues l on f.subject_type = 'league' and l.id = f.subject_id
    where f.user_id = ${userId}
    order by (f.subject_type = 'team') desc, label
    limit ${limit}
  `;
}

/* ---------------------------------------------------------------- schedule -- */

/** The signed-in calendar: every upcoming game involving anything the user follows. */
export async function upcomingForUser(userId, { limit = 100 } = {}) {
  return sql`
    select distinct e.*, l.name as league_name, l.abbreviation as league_abbr, l.sport, true as following,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    join follows f on f.user_id = ${userId}
      and (
        (f.subject_type = 'league' and f.subject_id = e.league_id)
        or (f.subject_type = 'team' and f.subject_id in (e.home_team_id, e.away_team_id))
      )
    where e.starts_at > now() - interval '3 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

/**
 * Somebody else's upcoming games, for their public profile.
 *
 * Deliberately not upcomingForUser with a flag. That query stamps every row
 * `following: true`, which EventRow draws as a star titled "You follow one of
 * these teams" -- true on the owner's own My games list, a lie on a stranger's
 * profile, where it would tell every visitor they follow whatever the profile's
 * owner follows. Here the star is the viewer's business and is left off.
 *
 * Finished games are excluded outright rather than kept for three hours the way
 * My games keeps them. That grace exists so the owner can find a match that just
 * ended; a visitor reading a profile is asking what is coming, not what was.
 */
export async function upcomingForProfile(userId, { limit = 10 } = {}) {
  return sql`
    select distinct e.*, l.name as league_name, l.abbreviation as league_abbr, l.sport, false as following,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    join follows f on f.user_id = ${userId}
      and (
        (f.subject_type = 'league' and f.subject_id = e.league_id)
        or (f.subject_type = 'team' and f.subject_id in (e.home_team_id, e.away_team_id))
      )
    where e.starts_at > now()
    order by e.starts_at
    limit ${limit}
  `;
}

/** The public calendar, identical for every visitor, so it is cacheable wholesale. */
export async function scheduleForDay({ day, sport = null, limit = 300, viewerId = null }) {
  if (sport) {
    return sql`
      select e.*, l.name as league_name, l.abbreviation as league_abbr, l.sport,
             exists (
               select 1 from follows vf
               where vf.user_id = ${viewerId}
                 and (
                   (vf.subject_type = 'team' and vf.subject_id in (e.home_team_id, e.away_team_id))
                   or (vf.subject_type = 'league' and vf.subject_id = e.league_id)
                 )
             ) as following,
             ht.display_name as home_name, ht.logo_url as home_logo,
             at.display_name as away_name, at.logo_url as away_logo
      from events e
      join leagues l on l.id = e.league_id
      left join teams ht on ht.id = e.home_team_id
      left join teams at on at.id = e.away_team_id
      where e.starts_at >= ${day}::date and e.starts_at < ${day}::date + interval '1 day'
        and l.sport = ${sport}
      order by e.starts_at limit ${limit}
    `;
  }
  return sql`
    select e.*, l.name as league_name, l.abbreviation as league_abbr, l.sport,
           exists (
             select 1 from follows vf
             where vf.user_id = ${viewerId}
               and (
                 (vf.subject_type = 'team' and vf.subject_id in (e.home_team_id, e.away_team_id))
                 or (vf.subject_type = 'league' and vf.subject_id = e.league_id)
               )
           ) as following,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.starts_at >= ${day}::date and e.starts_at < ${day}::date + interval '1 day'
    order by l.priority, e.starts_at limit ${limit}
  `;
}

/**
 * Every game in progress right now, across the whole catalogue.
 *
 * For finding something to watch rather than for keeping up with what you already
 * follow -- so it is deliberately not filtered by follows, and the ordering is by
 * league priority rather than by kick-off: a reader scanning this wants the big
 * competitions first, not whichever obscure fixture started most recently.
 *
 * `state = 'in'` only, and not the "kicked off in the last half hour" widening
 * that leaguesWithLiveGames uses. That widening exists so the tick refreshes a
 * league whose scores have not landed yet; borrowing it here would put postponed
 * fixtures -- which keep `pre` and a start time in the past -- in a list headed
 * "live now". The tick flips a real kick-off to `in` within a minute, which is
 * the same minute this page is cached for.
 *
 * The limit is a ceiling, not a page: on a Saturday afternoon there are more games
 * in progress than anybody scrolls, and the tail of that list is where the
 * catalogue's least-followed leagues live.
 */
export async function liveNow({ limit = 30, viewerId = null } = {}) {
  return sql`
    select e.*, l.name as league_name, l.abbreviation as league_abbr, l.slug as league_slug, l.sport,
           exists (
             select 1 from follows vf
             where vf.user_id = ${viewerId}
               and (
                 (vf.subject_type = 'team' and vf.subject_id in (e.home_team_id, e.away_team_id))
                 or (vf.subject_type = 'league' and vf.subject_id = e.league_id)
               )
           ) as following,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.state = 'in'
    order by l.priority, e.starts_at
    limit ${limit}
  `;
}

/** How many games are in progress, whether or not they all fit in the list. */
export async function liveNowCount() {
  const [row] = await sql`select count(*)::int as n from events where state = 'in'`;
  return row?.n ?? 0;
}

export async function getEvent(eventId) {
  const [row] = await sql`
    select e.*, l.name as league_name, l.slug as league_slug, l.sport,
           l.abbreviation as league_abbr,
           ht.display_name as home_name, ht.logo_url as home_logo, ht.slug as home_slug,
           at.display_name as away_name, at.logo_url as away_logo, at.slug as away_slug
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.id = ${eventId}
  `;
  return row ?? null;
}

/* --------------------------------------------------------------- reminders -- */

/**
 * Events crossing a reminder threshold in this tick.
 *
 * The window is bounded on both sides. The lower bound is what stops a backlog from
 * firing "starts in 1 hour" for games that kicked off twenty minutes ago after the
 * worker has been down -- late reminders are worse than absent ones.
 */
export async function eventsDueForReminder({ offsetMinutes, lookbackSeconds, timed = true }) {
  return sql`
    select e.id, e.starts_at, e.name, e.short_name, e.league_id, e.time_known
    from events e
    where e.state = 'pre'
      -- Matched to the offset's class. Querying both with one offset would fire
      -- the 1-minute reminder for every date-only event at 11:59, against a noon
      -- anchor nobody chose.
      and e.time_known = ${timed}
      -- A month- or year-precision date is not a promise, so it never triggers a
      -- reminder. It stays browsable; it just cannot be alarmed on.
      and e.precision in ('second', 'minute', 'hour', 'day')
      and e.starts_at - (${offsetMinutes} * interval '1 minute') <= now()
      and e.starts_at - (${offsetMinutes} * interval '1 minute') > now() - (${lookbackSeconds} * interval '1 second')
    order by e.starts_at
  `;
}

/**
 * One page of the people to notify about one event, keyset-paginated by user id.
 *
 * Keyset rather than OFFSET on purpose: a popular final can have millions of
 * followers, and OFFSET re-scans everything it skips, so page N gets linearly
 * slower. The `> after` form stays flat, and it cannot repeat or drop a row when
 * a follow is added mid-fan-out.
 */
export async function followersOfEventPage({
  eventId,
  after = '00000000-0000-0000-0000-000000000000',
  limit = 500,
}) {
  return sql`
    select distinct f.user_id
    from events e
    join follows f
      on (f.subject_type = 'league' and f.subject_id = e.league_id)
      or (f.subject_type = 'team' and f.subject_id in (e.home_team_id, e.away_team_id))
    where e.id = ${eventId} and f.user_id > ${after}::uuid
    order by f.user_id
    limit ${limit}
  `;
}

/** Delivery targets for a page of users: their channels and live push endpoints. */
export async function deliveryTargets(userIds) {
  if (userIds.length === 0) return [];
  return sql`
    select u.id as user_id, u.email, u.timezone,
           coalesce(p.channels, '{webpush,email}') as channels,
           coalesce(p.offsets_minutes, '{60,1}') as offsets_minutes,
           coalesce(p.date_offsets_minutes, '{1440,0}') as date_offsets_minutes,
           coalesce(
             json_agg(json_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh, 'auth', ps.auth))
               filter (where ps.id is not null and ps.disabled_at is null),
             '[]'
           ) as push_subscriptions
    from users u
    left join reminder_prefs p on p.user_id = u.id
    left join push_subscriptions ps on ps.user_id = u.id and ps.disabled_at is null
    where u.id = any(${pgArray(userIds)}::uuid[])
    group by u.id, p.channels, p.offsets_minutes, p.date_offsets_minutes
  `;
}

/**
 * Claim the right to send, before sending.
 *
 * The database is the arbiter: whichever worker inserts the row first owns that
 * delivery, and a concurrent or duplicated job gets an empty set back and sends
 * nothing. Claiming after the send instead would make every retry a second
 * notification to a real person's phone.
 *
 * The one exception is a delivery that already failed. Without it the claim row
 * from a failed send blocks every retry, so BullMQ's five attempts would re-claim
 * nothing and the reminder would be lost on the first transient push error --
 * retries that exist but cannot do anything. A row already marked `sent` is never
 * re-claimed, so this can resurrect a failure without ever duplicating a success.
 */
export async function claimDeliveries(rows) {
  if (rows.length === 0) return [];
  return sql`
    insert into reminder_deliveries ${sql(rows)}
    on conflict (event_id, user_id, offset_minutes, channel) do update
      set status = 'sent', sent_at = now()
      where reminder_deliveries.status = 'failed'
    returning event_id, user_id, offset_minutes, channel
  `;
}

export async function markDeliveryFailed({ eventId, userId, offsetMinutes, channel }) {
  await sql`
    update reminder_deliveries set status = 'failed'
    where event_id = ${eventId} and user_id = ${userId}
      and offset_minutes = ${offsetMinutes} and channel = ${channel}
  `;
}

/* ------------------------------------------------------------- push subs --- */

export async function savePushSubscription({ userId, endpoint, p256dh, auth }) {
  await sql`
    insert into push_subscriptions ${sql({ user_id: userId, endpoint, p256dh, auth })}
    on conflict (endpoint) do update set
      user_id = excluded.user_id, p256dh = excluded.p256dh,
      auth = excluded.auth, disabled_at = null
  `;
}

/** Called on a 404/410 from the push service: the browser threw the subscription away. */
export async function disablePushSubscription(endpoint) {
  await sql`update push_subscriptions set disabled_at = now() where endpoint = ${endpoint}`;
}

export async function getPrefs(userId) {
  const [row] = await sql`select * from reminder_prefs where user_id = ${userId}`;
  return row ?? null;
}

export async function savePrefs({ userId, offsetsMinutes, dateOffsetsMinutes, channels }) {
  /*
   * dateOffsetsMinutes is optional so an existing caller keeps working.
   *
   * Passing undefined must leave the stored list alone rather than blanking it --
   * `coalesce(excluded, existing)` rather than a plain assignment -- or a reader
   * who saves their kickoff preferences silently loses their release ones.
   */
  const dates = dateOffsetsMinutes === undefined ? null : pgArray(dateOffsetsMinutes);
  await sql`
    insert into reminder_prefs (user_id, offsets_minutes, date_offsets_minutes, channels)
    values (
      ${userId},
      ${pgArray(offsetsMinutes)}::int[],
      coalesce(${dates}::int[], '{1440,0}'),
      ${pgArray(channels)}::text[]
    )
    on conflict (user_id) do update set
      offsets_minutes = excluded.offsets_minutes,
      date_offsets_minutes =
        coalesce(${dates}::int[], reminder_prefs.date_offsets_minutes),
      channels = excluded.channels,
      updated_at = now()
  `;
}

/**
 * Every reminder offset any user has actually chosen, unioned with the defaults.
 *
 * The scanner must look for exactly these thresholds. Scanning only the defaults
 * would silently never fire a custom offset; scanning a fixed wide range would burn
 * a query per minute-value nobody uses.
 */
/**
 * Which offsets any reader has asked for, per reminder class.
 *
 * `timed` picks the column. An event with a real kickoff uses offsets_minutes
 * (60, 1); one that only has a date uses date_offsets_minutes (1440, 0). Zero is
 * meaningful for a date ("on the day") and meaningless for a time, which is why
 * the filter differs between them.
 */
export async function distinctReminderOffsets(defaults, { timed = true } = {}) {
  const rows = timed
    ? await sql`select distinct unnest(offsets_minutes) as m from reminder_prefs`
    : await sql`select distinct unnest(date_offsets_minutes) as m from reminder_prefs`;
  return [...new Set([...defaults, ...rows.map((r) => r.m)])]
    .filter((m) => (timed ? m > 0 : m >= 0))
    .sort((a, b) => b - a);
}

/** Replace a catalogue slug with the provider's real display name once we see it. */
export async function renameLeague({ id, name, abbreviation, logoUrl }) {
  await sql`
    update leagues set
      name = ${name},
      abbreviation = coalesce(${abbreviation ?? null}, abbreviation),
      logo_url = coalesce(${logoUrl ?? null}, logo_url)
    where id = ${id}
  `;
}

export async function getLeagueBySlug(slug) {
  const [row] = await sql`select * from leagues where slug = ${slug} and active`;
  return row ?? null;
}

/**
 * A league's own upcoming fixtures.
 *
 * Not "today's schedule filtered to this league" -- that was the first cut, and it
 * told anyone visiting a league with no game today that it had no fixtures at all.
 */
export async function upcomingForLeague(leagueId, { limit = 200, viewerId = null } = {}) {
  return sql`
    select e.*, l.name as league_name, l.abbreviation as league_abbr, l.sport,
           exists (
             select 1 from follows vf
             where vf.user_id = ${viewerId}
               and (
                 (vf.subject_type = 'team' and vf.subject_id in (e.home_team_id, e.away_team_id))
                 or (vf.subject_type = 'league' and vf.subject_id = e.league_id)
               )
           ) as following,
           ht.display_name as home_name, ht.logo_url as home_logo,
           at.display_name as away_name, at.logo_url as away_logo
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.league_id = ${leagueId} and e.starts_at > now() - interval '3 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

/** Counts for the public API index and the about page. */
export async function catalogueStats() {
  const [row] = await sql`
    select
      (select count(*)::int from leagues where active)                as leagues,
      (select count(distinct sport)::int from leagues where active)   as sports,
      (select count(*)::int from teams)                               as teams,
      (select count(*)::int from events where starts_at > now())      as upcoming_events,
      (select max(updated_at) from events)                            as last_sync
  `;
  return row;
}

/** Public API event feed. Bounded and ordered so it cannot be used to scrape the lot. */
export async function publicEvents({ leagueSlug = null, sport = null, from = null, limit = 100 }) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
  return sql`
    select e.id, e.starts_at, e.state, e.status_detail, e.name, e.short_name, e.venue,
           e.venue_city, e.venue_region, e.neutral_site,
           e.home_score, e.away_score,
           l.slug as league, l.name as league_name, l.abbreviation as league_abbr, l.sport,
           ht.display_name as home, at.display_name as away
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.starts_at > coalesce(${from}::timestamptz, now() - interval '3 hours')
      and (${leagueSlug}::text is null or l.slug = ${leagueSlug})
      and (${sport}::text is null or l.sport = ${sport})
    order by e.starts_at
    limit ${cap}
  `;
}

/** Months that actually contain fixtures, for the sitemap index. */
export async function eventMonths() {
  return sql`
    select to_char(starts_at, 'YYYY-MM') as month, count(*)::int as n, max(updated_at) as lastmod
    from events
    group by 1 order by 1
  `;
}

/** One month of events for a sitemap chunk. Ordered by (starts_at, id): ordering by
 *  the timestamp alone leaves rows stamped in the same bulk write in an undefined
 *  order, and paginating an undefined order can repeat a row in one chunk while
 *  dropping it from another. */
export async function eventsForMonth(month, { limit = 45000, offset = 0 } = {}) {
  return sql`
    select id, updated_at from events
    where to_char(starts_at, 'YYYY-MM') = ${month}
    order by starts_at, id
    limit ${limit} offset ${offset}
  `;
}

/* ------------------------------------------------------- browse + follow -- */

/**
 * Teams in a league, with whether this user already follows each.
 *
 * The follow state is joined rather than fetched separately so the picker can render
 * the right button in one pass; a second round trip per team is what makes a
 * 500-team league page crawl.
 */
export async function teamsForLeague(leagueId, userId = null) {
  return sql`
    select t.id, t.slug, t.display_name, t.logo_url,
           (f.user_id is not null) as following,
           (select count(*)::int from events e
             where (e.home_team_id = t.id or e.away_team_id = t.id)
               and e.starts_at > now()) as upcoming
    from team_leagues tl
    join teams t on t.id = tl.team_id
    left join follows f
      on f.subject_type = 'team' and f.subject_id = t.id and f.user_id = ${userId}::uuid
    where tl.league_id = ${leagueId}
    order by t.display_name
  `;
}

export async function getTeamBySlug(slug) {
  const [row] = await sql`
    select t.*, l.name as league_name, l.abbreviation as league_abbr, l.slug as league_slug, l.sport
    from teams t left join leagues l on l.id = t.league_id
    where t.slug = ${slug}
  `;
  return row ?? null;
}

export async function isFollowing({ userId, subjectType, subjectId }) {
  if (!userId) return false;
  const [row] = await sql`
    select 1 from follows
    where user_id = ${userId} and subject_type = ${subjectType} and subject_id = ${subjectId}
  `;
  return Boolean(row);
}

/** A single team's upcoming fixtures, home or away. */
export async function upcomingForTeam(teamId, { limit = 60, viewerId = null } = {}) {
  return sql`
    select e.*, l.name as league_name, l.abbreviation as league_abbr, l.sport,
           exists (
             select 1 from follows vf
             where vf.user_id = ${viewerId}
               and (
                 (vf.subject_type = 'team' and vf.subject_id in (e.home_team_id, e.away_team_id))
                 or (vf.subject_type = 'league' and vf.subject_id = e.league_id)
               )
           ) as following,
           ht.display_name as home_name, at.display_name as away_name
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where (e.home_team_id = ${teamId} or e.away_team_id = ${teamId})
      and e.starts_at > now() - interval '3 hours'
    order by e.starts_at
    limit ${limit}
  `;
}

/** Remember the viewer's timezone, which is what email reminders are stamped in. */
export async function setUserTimezone(userId, timezone) {
  await sql`update users set timezone = ${timezone} where id = ${userId}`;
}

/** Leagues in a sport, with whether this user follows each. */
export async function leaguesForSport(sport, userId = null) {
  return sql`
    select l.*, (f.user_id is not null) as following
    from leagues l
    left join follows f
      on f.subject_type = 'league' and f.subject_id = l.id and f.user_id = ${userId}::uuid
    where l.active and l.sport = ${sport}
    order by l.priority, l.name
  `;
}

/** Stamp a league as roster-checked, whether or not it had one. */
/**
 * When this category last COMPLETED a pass.
 *
 * rosters_synced_at, not events.updated_at -- every sync touches updated_at, so
 * that column always looks a minute old and nothing is ever judged overdue. Only a
 * finished pass writes this one, which is the whole reason it exists.
 */
export async function lastSyncedAtForCategory(category) {
  const [row] = await sql`
    select max(rosters_synced_at) as at from leagues where sport = ${category} and active
  `;
  return row?.at ?? null;
}

export async function markRostersSynced(leagueId) {
  await sql`update leagues set rosters_synced_at = now() where id = ${leagueId}`;
}

/** How many active leagues have never had their roster fetched. */
export async function leaguesMissingRosters() {
  const [row] = await sql`
    select count(*)::int as n from leagues where active and rosters_synced_at is null
  `;
  return row.n;
}

/**
 * Record which competitions a team plays in.
 *
 * Separate from the teams upsert because it is many-to-many: a club appears in its
 * league, its cup and often a continental competition, and each sweep should add
 * its own edge rather than overwrite the others.
 */
export async function linkTeamsToLeague(teamIds, leagueId) {
  if (teamIds.length === 0) return;
  await sql`
    insert into team_leagues (team_id, league_id)
    select unnest(${pgArray(teamIds)}::bigint[]), ${leagueId}
    on conflict do nothing
  `;
}

/**
 * Leagues with a game in progress, or one that just kicked off.
 *
 * Drives the live tick. Deliberately narrow: on a normal evening this is a handful
 * of leagues out of 354, so refreshing scores every minute costs a handful of
 * requests rather than a full sweep.
 */
export async function leaguesWithLiveGames() {
  return sql`
    select distinct l.*
    from leagues l
    join events e on e.league_id = l.id
    where l.active
      and (
        e.state = 'in'
        -- A game that has just started but whose state we have not refreshed yet;
        -- without this the first minutes of every match show no score at all.
        or (e.state = 'pre' and e.starts_at between now() - interval '30 minutes' and now() + interval '5 minutes')
      )
  `;
}

/**
 * Write only what changes during a game.
 *
 * Deliberately not the full event upsert: a live tick must never touch kickoff
 * time, teams or venue, so a provider hiccup mid-match cannot rewrite the fixture
 * itself. Rows that do not already exist are ignored rather than inserted.
 */
export async function updateEventScores(rows) {
  if (rows.length === 0) return [];

  // Column-wise arrays through unnest, not a row-wise VALUES list.
  //
  // `from (values ${sql(rows)})` looks natural and fails at runtime with "Cannot
  // use array of objects for UPDATE" -- Bun's helper builds VALUES for INSERT, not
  // for an UPDATE ... FROM. The live tick caught that, counted it as a failure and
  // printed nothing, so every score froze for two hours and it read like an
  // upstream block.
  return sql`
    update events e set
      state = v.state,
      status_detail = v.status_detail,
      home_score = v.home_score,
      away_score = v.away_score,
      period = v.period,
      display_clock = v.display_clock,
      attendance = coalesce(v.attendance, e.attendance),
      -- Same rule as the sweep. This tick is where a US listing usually appears:
      -- ESPN assigns most of them close to kickoff, so the live pass is the one
      -- that upgrades a fallback listing to the real broadcaster.
      broadcast = coalesce(v.broadcast, e.broadcast),
      broadcast_source = case when v.broadcast is not null then 'espn' else e.broadcast_source end,
      broadcast_country = case when v.broadcast is not null then 'United States' else e.broadcast_country end,
      broadcast_markets =
        case when v.broadcast is not null then v.markets::jsonb else e.broadcast_markets end,
      updated_at = now()
    from (
      select * from unnest(
        ${pgArray(rows.map((r) => r.provider))}::text[],
        ${pgArray(rows.map((r) => r.provider_key))}::text[],
        ${pgArray(rows.map((r) => r.state))}::text[],
        ${pgArray(rows.map((r) => r.status_detail ?? null))}::text[],
        ${pgArray(rows.map((r) => r.home_score ?? null))}::int[],
        ${pgArray(rows.map((r) => r.away_score ?? null))}::int[],
        ${pgArray(rows.map((r) => r.period ?? null))}::int[],
        ${pgArray(rows.map((r) => r.display_clock ?? null))}::text[],
        ${pgArray(rows.map((r) => r.attendance ?? null))}::int[],
        ${pgArray(rows.map((r) => r.broadcast ?? null))}::text[],
        ${pgArray(rows.map((r) => (r.broadcast ? JSON.stringify(r.markets ?? []) : null)))}::text[]
      ) as t(provider, provider_key, state, status_detail, home_score, away_score,
             period, display_clock, attendance, broadcast, markets)
    ) v
    where e.provider = v.provider and e.provider_key = v.provider_key
    returning e.id
  `;
}

/** Forget a push subscription entirely: the browser has revoked it or the user
 *  turned notifications off, and a disabled row would still look like a device. */
export async function deletePushSubscription({ userId, endpoint }) {
  await sql`delete from push_subscriptions where user_id = ${userId} and endpoint = ${endpoint}`;
}

/* ------------------------------------------------------------- feeds/ics -- */

/** Resolve a calendar subscription URL back to its owner. */
export async function userByCalendarToken(token) {
  const [row] = await sql`select * from users where calendar_token = ${token}::uuid`;
  return row ?? null;
}

/** Issue a new token, invalidating every calendar URL already handed out. */
export async function rotateCalendarToken(userId) {
  const [row] = await sql`
    update users set calendar_token = gen_random_uuid() where id = ${userId}
    returning calendar_token
  `;
  return row?.calendar_token ?? null;
}

/**
 * Public feed of upcoming fixtures, optionally scoped.
 *
 * Ordered by start time and bounded: a feed is a window on what is next, not a
 * dump of the catalogue. Includes team names and the league so an item reads
 * standalone in a reader that shows nothing else.
 */
export async function feedEvents({
  sport = null,
  leagueSlug = null,
  teamSlug = null,
  limit = 100,
}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
  return sql`
    select e.id, e.starts_at, e.name, e.short_name, e.venue, e.state,
           e.venue_city, e.venue_region, e.neutral_site,
           e.home_score, e.away_score, e.status_detail, e.broadcast, e.broadcast_country,
           e.updated_at,
           l.name as league_name, l.abbreviation as league_abbr, l.slug as league_slug, l.sport,
           ht.display_name as home_name, at.display_name as away_name
    from events e
    join leagues l on l.id = e.league_id
    left join teams ht on ht.id = e.home_team_id
    left join teams at on at.id = e.away_team_id
    where e.starts_at > now() - interval '3 hours'
      and (${sport}::text is null or l.sport = ${sport})
      and (${leagueSlug}::text is null or l.slug = ${leagueSlug})
      and (${teamSlug}::text is null or ht.slug = ${teamSlug} or at.slug = ${teamSlug})
    order by e.starts_at
    limit ${cap}
  `;
}

/** Leagues with something upcoming, for the feed directory. */
export async function leaguesWithUpcoming(limit = 400) {
  return sql`
    select l.slug, l.name, l.sport, count(e.id)::int as upcoming
    from leagues l
    join events e on e.league_id = l.id and e.starts_at > now()
    where l.active
    group by l.slug, l.name, l.sport
    order by count(e.id) desc, l.name
    limit ${limit}
  `;
}

/* --------------------------------------------------------------- plays --- */

/**
 * Events whose play log is due a refresh.
 *
 * A summary response is ~500KB, so this is deliberately narrow and spaced: games
 * actually in progress, oldest-refreshed first, and capped. Re-reading every live
 * game every minute would cost more bandwidth than the rest of the app combined --
 * and all of it metered, since these go through the proxy.
 *
 * Plus one last read after the whistle. Scoping this to `in` alone lost the end of
 * every game: the poll runs every two minutes, the final score and the flip to
 * `post` arrive on the one-minute score tick, and the event stops matching before
 * the last drive is ever fetched -- so the recap on a finished game ended somewhere
 * short of the finish. `plays_final` is what closes one out, and we set it
 * ourselves: inferring it from `updated_at` moving looked equivalent and was not,
 * because the score tick writes that column for every fixture on a league's
 * scoreboard -- finished ones included -- for as long as that league has any game
 * in progress. Games that had ended hours earlier kept re-qualifying every minute,
 * so the queue churned instead of draining and each pass spent another 500KB per
 * fixture. `catchupHours` bounds how far back that closing read reaches, which is a
 * cost limit rather than a rule -- see config.sports.playsCatchupHours for widening
 * it to backfill history.
 *
 * `state = 'in'` on its own is not a claim that a game is on right now, only that
 * nothing ever said otherwise. A fixture the provider stops returning keeps that
 * state forever, and those accumulate -- so the poller spent its whole quota
 * re-reading finished games while the fixtures someone was actually watching sat
 * behind the cap and never got a first read at all. `updated_at` is the honest
 * signal: the score tick stamps it every minute for the leagues that have a game
 * on, so a row it is still touching is genuinely live, and one it has stopped
 * touching drops out on its own without anyone having to decide what counts as
 * "too long" for a sport whose fixtures can legitimately run for days.
 *
 * `plays_supported` keeps competitions that can never have a log out of the queue
 * entirely. Ten of the sixteen sports in the catalogue either return a boxscore and
 * nothing else, or have no summary for the kind of id we store -- and their fixtures
 * were taking slots every cycle to come back empty, ahead of leagues that do have a
 * log. See 0012_plays_supported.sql for how that was measured.
 *
 * Each row also carries how many matched in total. The caller only ever sees the
 * capped slice, so a queue it can never drain looks exactly like a queue it just
 * drained -- which is how live fixtures went a whole game without a play log while
 * the worker logged "0 failed" every two minutes. A window function is evaluated
 * before the limit, so this is the true total and costs no second round trip.
 *
 * One state at a time, because the two are not interchangeable and must not queue
 * behind each other. A live game needs reading again and again while it is on; a
 * finished one needs reading exactly once more. Drawn from one pool the finished
 * ones win on age alone -- 252 of them took every slot for an hour while the
 * fixtures actually being played got nothing -- so the caller asks for each
 * separately and gives the live ones the bulk of the quota.
 */
export async function eventsNeedingPlays({
  staleSeconds = 120,
  limit = 10,
  state = 'in',
  catchupHours = 12,
} = {}) {
  return sql`
    select e.id, e.state, e.provider_key, l.provider_key as league_key, l.provider,
           (count(*) over ())::int as total_due
    from events e
    join leagues l on l.id = e.league_id
    where e.state = ${state}
      and l.plays_supported
      and (
        (e.state = 'in'
          and e.updated_at > now() - interval '10 minutes'
          and (e.plays_synced_at is null
               or e.plays_synced_at < now() - (${staleSeconds} * interval '1 second')))
        or
        (e.state = 'post'
          and e.starts_at > now() - (${catchupHours} * interval '1 hour')
          and not e.plays_final)
      )
    -- Each queue wants the opposite end. Among live games the fairest next read is
    -- the one waiting longest, so they take turns. Among finished ones age is the
    -- wrong tiebreak entirely: the game that just went final is the one somebody is
    -- refreshing for the recap, and ordering by last-read put it behind a backlog
    -- of yesterday's fixtures -- roughly five hours behind, at two reads a tick.
    -- The case is null for every row in the live queue, so that falls straight
    -- through to the second key.
    order by (case when e.state = 'post' then e.starts_at end) desc nulls last,
             e.plays_synced_at asc nulls first
    limit ${limit}
  `;
}

/** Close out a finished game's log, so its one catch-up read is not repeated. */
export async function markPlaysFinal(eventId) {
  await sql`update events set plays_final = true, plays_synced_at = now() where id = ${eventId}`;
}

export async function markPlaysSynced(eventId) {
  await sql`update events set plays_synced_at = now() where id = ${eventId}`;
}

/** Append only what is new; a re-read of the same game is a no-op. */
export async function insertPlays(rows) {
  if (rows.length === 0) return [];
  return sql`
    insert into event_plays ${sql(rows)}
    on conflict (event_id, provider_play_id) do nothing
    returning id
  `;
}

export async function playsForEvent(eventId, { limit = 60 } = {}) {
  return sql`
    select * from event_plays
    where event_id = ${eventId}
    order by sequence desc nulls last, id desc
    limit ${limit}
  `;
}

/* ------------------------------------------------------------ comments --- */

export async function commentsForEvent(eventId, { limit = 200 } = {}) {
  return sql`
    -- handle/display_name so a comment can be signed with a chosen name and link
    -- to its author. email stays only as the fallback for accounts that have not
    -- picked a handle, and the view never prints more than its local part.
    select c.id, c.body, c.created_at, u.email, u.id as user_id,
           u.handle, u.display_name, u.profile_public
    from event_comments c
    join users u on u.id = c.user_id
    where c.event_id = ${eventId} and c.deleted_at is null
    order by c.created_at desc
    limit ${limit}
  `;
}

/** How many this person has posted in the last minute, for rate limiting. */
export async function recentCommentCount(userId, seconds = 60) {
  const [row] = await sql`
    select count(*)::int as n from event_comments
    where user_id = ${userId} and created_at > now() - (${seconds} * interval '1 second')
  `;
  return row.n;
}

export async function insertComment({ eventId, userId, body }) {
  const [row] = await sql`
    insert into event_comments ${sql({ event_id: eventId, user_id: userId, body })}
    returning id, body, created_at
  `;
  return row;
}

/** Soft delete, and only your own: the row stays for moderation history. */
export async function deleteComment({ commentId, userId }) {
  const [row] = await sql`
    update event_comments set deleted_at = now()
    where id = ${commentId} and user_id = ${userId} and deleted_at is null
    returning id
  `;
  return Boolean(row);
}
