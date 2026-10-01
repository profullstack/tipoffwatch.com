-- Remove the unfilled playoff slots stored as if they were teams.
--
-- ESPN publishes a postseason before it knows who is in it: each undecided side is
-- a competitor with a negative id ("baseball/mlb/-1") named "TBD". The mirror took
-- those at face value, so the 2026 MLB bracket became 31 "TBD at TBD" fixtures at
-- a padded midnight, and two clubs called TBD with a Follow button. The mappers now
-- refuse them (isPlaceholderSide in nichedbsports.js, normaliseEvent in espn.js);
-- this clears what was already written.
--
-- A fixture with both sides undecided goes. One with a single real side stays --
-- it is that team's next game -- and loses the placeholder through the existing
-- `on delete set null`. Follows carry no foreign key, so they are cleared by hand.

create temporary table placeholder_teams on commit drop as
  select id from teams
  where provider_key ~ '/-[0-9]+$'
     or lower(display_name) in ('tbd', 'tba', 'tbc');

delete from events e
using placeholder_teams h, placeholder_teams a
where e.home_team_id = h.id and e.away_team_id = a.id;

delete from follows
where subject_type = 'team'
  and subject_id in (select id from placeholder_teams);

delete from teams where id in (select id from placeholder_teams);
