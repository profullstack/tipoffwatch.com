-- A team belongs to many competitions.
--
-- `teams.league_id` was a single FK, but a club plays in its domestic league, its
-- domestic cup and often a continental competition. Every league's sync overwrote
-- the column with its own id, so the last competition processed won and the club
-- disappeared from every other league's page: Everton ended up filed under the FA
-- Cup, and the Premier League page listed the eight clubs that happened to be
-- written last rather than its twenty members.
--
-- The relationship is many-to-many and now says so.
create table if not exists team_leagues (
  team_id   bigint not null references teams(id) on delete cascade,
  league_id bigint not null references leagues(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, league_id)
);

create index if not exists team_leagues_league_idx on team_leagues (league_id);

-- Backfill from whatever each row happened to be pointing at. Incomplete by
-- definition -- that is the bug -- but it means the join has data before the next
-- sweep rather than emptying every league page in the meantime.
insert into team_leagues (team_id, league_id)
select id, league_id from teams where league_id is not null
on conflict do nothing;

-- Force exactly one full re-sweep so the join table is populated from the provider
-- rather than only from the incomplete backfill above. Reusing the existing
-- rosters_synced_at trigger rather than inventing a second mechanism; migrations run
-- once, so this fires once.
update leagues set rosters_synced_at = null where active;
