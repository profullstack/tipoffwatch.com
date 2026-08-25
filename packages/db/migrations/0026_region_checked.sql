-- When we last ASKED where a league is played, as distinct from knowing.
--
-- 0025 shipped the backfill selecting `region is null` with a stable order and a
-- limit. That never terminates and never progresses: ESPN has no country for
-- anything outside domestic soccer, so the first forty unresolvable leagues come
-- back every single run and leagues 41 onward are never reached at all. The
-- backlog would have looked like it was draining and would not have moved.
--
-- Nullable, and null means "never asked" -- which is exactly what every existing
-- row is, so the first pass after this behaves the same as a fresh install.
alter table leagues add column if not exists region_checked_at timestamptz;

-- Partial, because the only query is "what have we not asked about lately" and
-- the answer shrinks to nothing once the catalogue is drained.
create index if not exists leagues_region_unchecked_idx
  on leagues (region_checked_at nulls first)
  where region is null;
