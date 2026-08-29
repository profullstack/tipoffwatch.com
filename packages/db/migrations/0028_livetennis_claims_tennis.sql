-- Handing tennis over from ESPN to the Live Tennis API.
--
-- ESPN publishes tennis as a fortnight-shaped "event" holding a tree of draws,
-- which the adapter flattens into fixtures. It works, and it is a thin read of the
-- sport: main tour in practice, no ranking, no surface, no round, and a scoreline
-- reconstructed from linescores. The new provider answers in tennis's own terms --
-- ATP, WTA, Challenger and ITF, singles and doubles, with the server, the points in
-- the game being played and games per set -- so it takes the sport outright.
--
-- Outright is the operative word. Two providers writing one sport is not
-- redundancy: it is every match stored twice under two league rows with two
-- unrelated sets of players, and a follow that sees half its fixtures depending on
-- which copy it happened to land on.
--
-- The routing itself lives in code, not here (`claimsSports` in
-- packages/sports/src/livetennis.js, enforced by syncCatalogue). This migration
-- does the one thing code cannot do idempotently: get out of the new provider's
-- way, once.

-- 1. Free the slugs.
--
-- `tennis-atp` and `tennis-wta` are the URLs people already have, and they should
-- keep working and start showing better data -- so livetennis takes them rather
-- than inventing `atp-tour` alongside. leagues.slug is unique, so the incumbent has
-- to move first or the very first catalogue pass fails on the insert.
--
-- Renaming is safe in a way that deleting would not be: upsertLeague's ON CONFLICT
-- never touches slug, so a rename sticks even though the ESPN row is still upserted
-- by any future pass where the claim is lifted.
update leagues
   set slug = 'espn-' || slug
 where sport = 'tennis'
   and provider = 'espn'
   and slug not like 'espn-%';

-- 2. Retire them.
--
-- syncCatalogue does this on every pass too, and deliberately: `active = true` is
-- in upsertLeague's ON CONFLICT clause, so without the code-side sweep these rows
-- would come back to life on the next catalogue run and the duplication with them.
-- Doing it here as well means the site is correct from the moment the migration
-- lands, rather than from whenever the next sweep happens to run.
--
-- Deactivated, never deleted. These rows carry finished fixtures and whatever
-- anyone already follows.
update leagues
   set active = false
 where sport = 'tennis'
   and provider = 'espn'
   and active;

-- 3. Note what this does NOT migrate: follows.
--
-- A followed tennis player is a `teams` row keyed to ESPN, and the same person
-- arrives from livetennis as a new row with a new key -- they are different ids in
-- different id spaces, and nothing but the name connects them. Remapping on a
-- normalised name is possible (packages/sports/src/sportsdb.js already has
-- normaliseTeam/sameTeam for exactly that shape of problem) but it cannot run here:
-- the livetennis rows do not exist until the first sweep does, so there is nothing
-- to match against at migration time. Left as a deliberate gap rather than a silent
-- one -- if tennis follows turn out to matter, the remap belongs in a follow-up
-- that runs after a sweep, not in a migration that runs before one.
