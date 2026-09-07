-- The line over time, rather than the line right now.
--
-- `events.odds` holds one reading and is overwritten by every sync that finds a
-- newer one. That is correct for a page, which wants the current number, and it
-- means the movement is destroyed as fast as it is captured: by kickoff the column
-- holds the closing line and no trace of the several times it moved to get there.
--
-- The provider does not sell that history and cannot be asked for it. It returns
-- exactly two points, where the market opened and where it stands, so a series of
-- observations is something only our own polling can build -- and only going
-- forward, because a reading not taken today cannot be recovered later. That is
-- the whole argument for writing this now rather than when it is needed.
--
-- Append-only. Nothing here is ever updated, and rows are inserted only when a
-- number actually changed (see recordOddsSnapshots), so a fixture polled every
-- minute for a week costs a handful of rows rather than ten thousand identical
-- ones.

create table if not exists event_odds_snapshots (
  id          bigserial primary key,
  event_id    bigint not null references events(id) on delete cascade,

  -- When WE saw it, not when the book changed it. The provider timestamps nothing,
  -- so this is an observation time and should be read as one: the true change
  -- happened somewhere between this row and the one before it.
  observed_at timestamptz not null default now(),

  -- Which book. One today (the provider returns a single one), a column anyway,
  -- because a series that cannot say whose price it is stops being worth anything
  -- the moment a second source is added.
  provider    text,

  /*
   * Columns rather than a jsonb copy of events.odds.
   *
   * The live column is jsonb because a page renders whatever shape arrives and the
   * sports differ. This table has the opposite job: it exists to be aggregated --
   * how far a line moved, how often, which way, across which leagues -- and every
   * one of those questions is a scan with a jsonb extraction per row against a
   * table that only grows. Numeric, so a spread of -3.5 stays -3.5 rather than
   * becoming a float that compares unequal to itself.
   */
  details        text,
  spread         numeric(6, 2),
  over_under     numeric(6, 2),
  favorite       text,
  home_moneyline int,
  away_moneyline int,
  draw_moneyline int,

  -- What the fixture's state was when this was taken. A reading captured while the
  -- game was still to be played is a live market; one recovered afterwards is a
  -- settled number the book is no longer standing behind, and mixing the two in an
  -- average is how a closing-line study quietly becomes wrong.
  captured_state text
);

-- The only access path this table has: one fixture's readings, newest first. Both
-- reading a game's history and the dedupe check on write are that query.
create index if not exists event_odds_snapshots_event_idx
  on event_odds_snapshots (event_id, observed_at desc);

-- Answering "what moved today" across every fixture at once, which is the shape of
-- every question asked of the archive as a whole rather than of one game.
create index if not exists event_odds_snapshots_observed_idx
  on event_odds_snapshots (observed_at desc);
