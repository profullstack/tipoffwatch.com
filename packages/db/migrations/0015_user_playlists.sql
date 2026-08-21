-- A reader's own channel list, for their own use.
--
-- This is a personal-player feature and the schema is shaped to keep it that way.
-- There is no sharing column, no visibility flag and no link to stream_offers,
-- because a list belongs to exactly one account and is never resold or pooled.
-- Everything is keyed by user_id and cascades on delete, so removing an account
-- removes the credentials with it.
create table if not exists user_playlists (
  id            bigserial primary key,
  -- One list per account. A second add replaces the first rather than accumulating
  -- credentials nobody remembers giving us.
  user_id       uuid not null unique references users(id) on delete cascade,
  label         text,
  -- AES-256-GCM, sealed by packages/auth/src/secretbox.js. The URL carries the
  -- reader's provider username and password in its path, so it is never stored in
  -- the clear and never rendered into a page.
  source_url    text not null,
  channel_count int not null default 0,
  last_synced_at timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);

create table if not exists user_playlist_channels (
  id          bigserial primary key,
  playlist_id bigint not null references user_playlists(id) on delete cascade,
  position    int not null,
  title       text not null,
  -- Sealed like the source URL, and for the same reason: it is the same credential
  -- with a channel id on the end.
  stream_url  text not null,
  -- The title reduced to lowercase words, so matching a fixture is an index scan
  -- rather than normalising 7,000 rows per page view. Written once at import.
  norm_title  text not null
);

-- The read path is "this user's channels, matched against two team names", so the
-- list is fetched whole per playlist and filtered in the app. Index the owner.
create index if not exists user_playlist_channels_playlist_idx
  on user_playlist_channels (playlist_id);

-- Substring search over normalised titles, for the day the filtering moves into
-- SQL. pg_trgm is already an extension here (see 0001), so this costs nothing to
-- carry and saves a migration later.
create index if not exists user_playlist_channels_norm_idx
  on user_playlist_channels using gin (norm_title gin_trgm_ops);
