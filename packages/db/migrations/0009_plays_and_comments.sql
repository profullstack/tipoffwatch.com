-- Live action log, and comments on a fixture.

-- ---------------------------------------------------------------------------
-- event_plays — the provider's play-by-play, appended as a game unfolds
-- ---------------------------------------------------------------------------
create table if not exists event_plays (
  id               bigserial primary key,
  event_id         bigint not null references events(id) on delete cascade,
  -- The provider's own id. Unique per event so re-fetching a summary appends only
  -- what is new: a live poll re-reads the whole game every time, and without this
  -- the log would grow by 170 duplicate rows a minute.
  provider_play_id text not null,
  sequence         bigint,
  text             text not null,
  away_score       int,
  home_score       int,
  scoring          boolean not null default false,
  period_number    int,
  period_label     text,
  play_type        text,
  created_at       timestamptz not null default now(),
  unique (event_id, provider_play_id)
);

-- The read path: newest first for one event.
create index if not exists event_plays_event_idx on event_plays (event_id, sequence desc);
-- Scoring plays alone make a decent recap, so they are worth reaching directly.
create index if not exists event_plays_scoring_idx on event_plays (event_id) where scoring;

-- When we last pulled a summary, so the poller can space them out. A summary is
-- ~500KB and the fixture sweep is already metered; re-reading every live game
-- every minute would dwarf everything else the app fetches.
alter table events add column if not exists plays_synced_at timestamptz;

-- ---------------------------------------------------------------------------
-- event_comments
-- ---------------------------------------------------------------------------
create table if not exists event_comments (
  id         bigserial primary key,
  event_id   bigint not null references events(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,

  -- Enforced here as well as in the handler: a length cap that lives only in
  -- application code stops applying the moment anything else writes a row.
  constraint event_comments_body_length check (char_length(body) between 1 and 2000)
);

create index if not exists event_comments_event_idx
  on event_comments (event_id, created_at desc) where deleted_at is null;
create index if not exists event_comments_user_idx on event_comments (user_id);

-- Rate limiting reads this: how many has this person posted in the last minute.
create index if not exists event_comments_recent_idx on event_comments (user_id, created_at desc);
