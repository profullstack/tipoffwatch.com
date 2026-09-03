-- A reader's own SiriusXM session, so the sports and news lineups can play here.
--
-- Same rail as user_playlists and the same rule: one per account, keyed by the
-- account, and both secrets sealed with the playlist key before they are
-- written. A SiriusXM session is the subscription -- whoever holds the token and
-- the cookie jar listens as the owner, from anywhere, until the owner changes
-- their password -- which is why there is no plaintext column and no query that
-- takes anything but a user_id.

create table if not exists siriusxm_sessions (
  user_id                  uuid primary key references users(id) on delete cascade,
  -- The address on the SiriusXM account, kept only so settings can say which one.
  email                    text,
  -- Sealed. The bearer every gateway call carries.
  access_token             text not null,
  -- Sealed. The Cookie header replayed against sessions/refresh when the bearer
  -- lapses; empty means the session cannot be renewed and must be re-connected.
  session_cookies          text not null default '',
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
