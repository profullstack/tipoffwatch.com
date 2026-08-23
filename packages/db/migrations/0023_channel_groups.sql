-- What shelf a channel sits on, and what kind of thing it is.
--
-- Ported from the sibling brand's 0002_user_playlists.sql, which carried both from
-- the start. A provider playlist is already a catalogue -- "Sports | US", "PPV",
-- "UK Documentary", "Movies | Action" -- and until now we parsed that string and
-- threw it away, so a reader's own channel rows were a bare title with nothing
-- saying what any of them was.
--
-- Stored verbatim and NOT mapped onto our leagues. Every provider names these
-- differently, and a confident wrong mapping is worse than the raw string, which
-- at least matches what the reader sees in their own player.
alter table user_playlist_channels
  add column if not exists group_title text;

/*
 * live | vod | series, decided at import from the URL and the group.
 *
 * Carried as a column rather than recomputed per read because it is derived from
 * the URL, and the URL is sealed at rest -- so answering "is this a file or a
 * channel" on a page would otherwise mean decrypting several thousand rows to
 * look at their paths.
 *
 * Nullable on purpose. Rows imported before this existed have no kind, and null
 * has to keep meaning "we never worked it out" rather than being defaulted to
 * 'live' -- that would assert something about every VOD entry already stored.
 */
alter table user_playlist_channels
  add column if not exists kind text;

-- Browsing a reader's own list by group is a per-owner grouping, not a global one.
create index if not exists user_playlist_channels_group_idx
  on user_playlist_channels (playlist_id, group_title);
