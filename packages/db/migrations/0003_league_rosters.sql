-- When a league's full team roster was last fetched.
--
-- Fixtures and rosters are different questions. The fixture sweep only sees clubs
-- with a game inside the horizon, so a follow picker built from fixtures alone
-- listed eight Premier League clubs instead of twenty. Rosters come from a separate
-- endpoint and are tracked separately so a backfill can be triggered exactly once
-- rather than on every boot.
--
-- Null means never attempted. It is stamped even when a league has no roster to
-- fetch (individual sports have no teams endpoint), so "attempted and empty" does
-- not look the same as "never tried" and re-trigger forever.
alter table leagues add column if not exists rosters_synced_at timestamptz;

create index if not exists leagues_rosters_pending_idx
  on leagues (id) where active and rosters_synced_at is null;
