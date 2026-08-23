-- Searching the things that are not participants.
--
-- The box in the header looks in five places, and four of them were already
-- indexed for it: teams has a trigram index on display_name, leagues is a few
-- hundred rows, user_playlist_channels has one on norm_title, and users.handle is
-- unique. events was the exception -- and it is the table that grows fastest, so a
-- sequential scan there is the one that turns into an outage rather than a slow
-- page.

/*
 * lower(name), not name.
 *
 * The query lowercases the needle once in JS and compares against lower(name), so
 * the index has to be over the same expression or it will never be used -- an
 * index on `name` cannot serve a predicate on `lower(name)`. lower(text) is
 * IMMUTABLE, so this is a legal expression index with no wrapper of our own.
 *
 * gin rather than gist: a table written in bulk by the sync passes and read far
 * more often than it is written, which is the shape gin is faster for, and a gin
 * trigram index answers `like '%...%'` as well as it answers similarity().
 */
create index if not exists events_name_trgm_idx
  on events using gin (lower(name) gin_trgm_ops);

-- Nothing is added for the "starting in the next four hours" list on the category
-- page. It reads `state = 'pre' and starts_at between now() and now() + 4h`, which
-- is a prefix of events_upcoming_idx from 0001 -- same partial predicate, same
-- sort column. A second index on the identical expression would be a duplicate
-- that costs a write on every fixture update and answers nothing new.
