-- Where a mirror keeps its place.
--
-- The nichedb-sports provider (packages/sports/src/nichedbsports.js) reads the
-- `sports` collection with `since=<last sync>` and pages by id, so between runs it
-- has to remember when it last looked and, when a walk was cut short by its
-- request budget, where in that walk it stopped. Neither fact belongs on a league
-- or an event row: they describe the SYNC, not the data.
--
-- One row per named cursor, jsonb so a provider can shape its own state. Nothing
-- reads the inside of the document server-side.
create table if not exists sync_cursors (
  name       text primary key,
  cursor     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
