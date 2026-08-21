-- Which competitions can have a play log at all.

-- ---------------------------------------------------------------------------
-- leagues.plays_supported — is there play-by-play to fetch for this competition
-- ---------------------------------------------------------------------------
--
-- The poller reads a fixed handful of summaries per tick, because each is ~500KB
-- through a metered proxy. Fixtures from sports the provider has no play data for
-- took those slots anyway, every cycle, and always came back with nothing -- so a
-- league that does have a log waited behind leagues that never will.
--
-- Measured across the whole catalogue on 2026-08-21, one finished fixture per sport:
--
--   yields plays   baseball, basketball, football, soccer, hockey, australian-football
--   boxscore only  field-hockey, lacrosse, rugby, rugby-league, volleyball, water-polo
--   no summary     tennis, golf, racing, mma
--
-- The last group is not a gap in the provider so much as a mismatch in what an
-- "event" is: for those sports a scoreboard event is a tournament, a race weekend
-- or a fight card, and the summary endpoint wants the individual match. Supporting
-- them means modelling sub-events, which is a bigger change than this one.
--
-- MMA looks like the near miss and is not one. Its scoreboard does carry a fight
-- inline, but the entries are bare markers -- "Round End", "Fight Over", "Results"
-- -- with no description and no participants, so there is no sentence to show.
--
-- Defaults to true so a competition we have never seen is tried rather than
-- written off, and so leagues added later are opted in automatically. Flipping one
-- back on is a single UPDATE, no deploy.
alter table leagues add column if not exists plays_supported boolean not null default true;

update leagues set plays_supported = false
where sport in (
  'field-hockey', 'lacrosse', 'rugby', 'rugby-league', 'volleyball', 'water-polo',
  'tennis', 'golf', 'racing', 'mma'
);
