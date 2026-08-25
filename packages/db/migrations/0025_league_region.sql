-- Telling one competition from another that is named almost the same.
--
-- Reported as "the one live game is miscategorized as NBA basketball". It was
-- not: Sydney Kings at Illawarra Hawks is Australia's NBL, whose real name is
-- "National Basketball League" -- one word from the NBA's "National Basketball
-- Association", and rendered as a four-letter chip that reads like a typo of it.
-- The data was right and the label could not be told apart, which from the
-- outside is the same defect.
--
-- Three columns, for three distinct ways a league can be unidentifiable.

-- 1. Where it is played. ESPN exposes `country` on the core league endpoint for
--    DOMESTIC SOCCER only -- 218 of our 354 leagues -- and gives nothing for
--    continental competitions or for any other sport. So this is nullable and
--    always will be, and anything reading it has to cope with null rather than
--    treat it as a bug. A small curated table in packages/sports/src/regions.js
--    fills the handful of non-soccer leagues where the name genuinely collides.
alter table leagues add column if not exists region text;

-- 2. Whether the abbreviation identifies anything on its own. Thirteen separate
--    MMA promotions abbreviate to "BFC"; two summer leagues both answer to
--    "NBAGS". A chip showing those is not short, it is wrong -- so the renderer
--    falls back to the full name, and this column is what tells it to.
--    Recomputed after every catalogue sync rather than derived per row: the
--    leagues table is small, the answer changes once a day at most, and the
--    alternative is a correlated subquery on every fixture ever listed.
alter table leagues add column if not exists abbr_ambiguous boolean not null default false;

-- 3. Genuine duplicates. ESPN ships the same competition under two keys --
--    `soccer/concacaf.champions` and `soccer/concacaf.champions_cup` both exist,
--    both return fixtures, and both are the CONCACAF Champions Cup.
--
--    Not a delete, and not `active = false`: upsertLeague sets `active = true`
--    on conflict, so the nightly catalogue sync would resurrect it. This column
--    is never written by the sync, which is exactly what makes the decision
--    stick, and it says WHICH row supersedes it rather than just hiding one.
alter table leagues add column if not exists superseded_by bigint references leagues(id) on delete set null;

create index if not exists leagues_superseded_idx on leagues (superseded_by)
  where superseded_by is not null;

-- Keyed on provider_key rather than on id, because ids differ per environment
-- and this has to mean the same thing on a laptop as in production. Idempotent:
-- re-running sets the same value. The surviving row is the one carrying 27 teams
-- against the other's 7; neither has any fixtures or followers, so nothing is
-- lost either way.
update leagues dup
   set superseded_by = keep.id
  from leagues keep
 where dup.provider = 'espn'
   and dup.provider_key = 'soccer/concacaf.champions_cup'
   and keep.provider = 'espn'
   and keep.provider_key = 'soccer/concacaf.champions'
   and dup.id <> keep.id;
