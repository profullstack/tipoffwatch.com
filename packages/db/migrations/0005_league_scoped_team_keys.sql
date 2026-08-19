-- Team provider keys are scoped by league, not by sport.
--
-- ESPN team ids are only unique WITHIN a league. Id 7 is the Denver Broncos in the
-- NFL and the Amherst Mammoths in college football; 20 of the NFL's 32 ids collide
-- with a college team. Keying teams as `<sport>/<id>` merged those pairs, so the
-- upsert overwrote one name with the other and the NFL page rendered fixtures like
-- "Cal Poly Mustangs at Houston Texans" -- not a display bug, genuinely the wrong
-- team attached to a real fixture.
--
-- Every existing team row carries a key from the broken scheme and cannot be
-- repaired in place: there is no way to tell which of two merged teams a given row
-- now describes. They are dropped and rebuilt from the provider.
--
-- Fixtures are kept. They are keyed independently and their team references are
-- nulled here, then repopulated by the sweep the reset below forces.
update events set home_team_id = null, away_team_id = null;

delete from team_leagues;
delete from teams;

-- Forces exactly one full re-sweep, which rebuilds every roster under the new keys.
update leagues set rosters_synced_at = null where active;
