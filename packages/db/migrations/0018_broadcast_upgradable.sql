-- The fallback pass now looks at two kinds of row, not one.
--
-- 0013 added a partial index for "broadcast is null", which was the whole work
-- list at the time. The pass now also revisits rows IT wrote, so that a listing
-- captured while the shared API key was truncating to a single channel can be
-- replaced by the full set once a subscriber key is in place. That second group is
-- invisible to the 0013 index, so without this the query falls back to a scan of
-- everything in the window.
--
-- ESPN's rows are in neither index and are never revisited: that source is the
-- more precise answer wherever it exists.
create index if not exists events_upgradable_broadcast_idx
  on events (starts_at)
  where broadcast_source = 'thesportsdb';
