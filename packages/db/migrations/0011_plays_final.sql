-- The play log for a finished game is complete: say so, once.

-- ---------------------------------------------------------------------------
-- events.plays_final — this game's action log will not change again
-- ---------------------------------------------------------------------------
--
-- A finished game is owed exactly one more read, for the plays that landed between
-- the last poll and the whistle. "Owed" was inferred from plays_synced_at being
-- older than updated_at, which was wrong: the score tick writes updated_at for
-- EVERY fixture on a league's scoreboard, finished ones included, for as long as
-- that league still has any game in progress. So a game that ended at 8pm went on
-- re-qualifying every single minute, and the catch-up queue churned instead of
-- draining -- 219 fixtures deep and rising, each re-read costing another 500KB
-- through the metered proxy.
--
-- A flag we set ourselves cannot be moved by anything upstream. Default false so
-- every fixture already stored gets its one read.
alter table events add column if not exists plays_final boolean not null default false;

-- The catch-up queue reads exactly this: recently finished, not yet closed out.
create index if not exists events_plays_pending_idx
  on events (starts_at desc) where state = 'post' and not plays_final;
