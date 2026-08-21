-- Where a broadcast listing came from, and which market it applies to.
--
-- ESPN's scoreboard only ever carries US listings, and only for part of the
-- catalogue: verified 2026-08-21, NFL was 16/16 and MLB 9/9, while AFL was 0/9,
-- NHL 0/7 and the EPL had nothing beyond the current week. A second source fills
-- those gaps, so a row now has to say who supplied it -- otherwise the two
-- sources overwrite each other on every sweep and nobody can tell which won.
--
-- Country matters for the same reason: "7 Queensland" is a correct answer for an
-- AFL game and a useless one for a reader in Ohio, so it is labelled rather than
-- presented as though it were universal.
alter table events add column if not exists broadcast_source  text;
alter table events add column if not exists broadcast_country text;

-- Everything already stored came from ESPN, which is US-only by construction.
update events
   set broadcast_source = 'espn',
       broadcast_country = 'US'
 where broadcast is not null
   and broadcast_source is null;

-- The fallback pass looks for fixtures inside the horizon that still have no
-- listing, which is a "where broadcast is null" scan over a table that is mostly
-- exactly that. Partial index so it stays proportional to the work, not the table.
create index if not exists events_missing_broadcast_idx
  on events (starts_at)
  where broadcast is null;
