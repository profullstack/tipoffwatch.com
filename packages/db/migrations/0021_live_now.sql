-- Games in progress, for the "Live now" list on the category page.
--
-- Partial, because that is the whole point: of every fixture ever synced, the
-- ones with state 'in' are a few dozen at a busy moment and zero for much of the
-- week. A partial index is then tiny and stays tiny, where an index on state
-- would carry a row for every finished game in the catalogue to answer a question
-- only ever asked about the live ones.
--
-- starts_at is in the key rather than the predicate so the ordering the list asks
-- for -- league priority, then kick-off -- has something to read; league priority
-- itself lives on leagues and is joined, so this covers the half that is here.
create index if not exists events_live_now_idx
  on events (starts_at)
  where state = 'in';
