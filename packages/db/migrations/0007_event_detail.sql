-- Detail an event page can actually show.
--
-- The page had the title, league, venue and kickoff time and nothing else -- not
-- even the score, which we already stored. These are the fields ESPN returns on
-- every scoreboard entry that are worth surfacing: who is broadcasting it, each
-- side's season record, where exactly, how many turned up, and the clock.
alter table events add column if not exists broadcast      text;
alter table events add column if not exists attendance     int;
alter table events add column if not exists venue_city     text;
alter table events add column if not exists period         int;
alter table events add column if not exists display_clock  text;
alter table events add column if not exists home_record    text;
alter table events add column if not exists away_record    text;

-- Live detail moves every minute during a game, so the live tick writes these too;
-- see updateEventScores.
