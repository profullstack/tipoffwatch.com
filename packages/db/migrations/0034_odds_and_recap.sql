-- The line before it starts, and the box score after it ends.
--
-- Two features, one migration, because they are the same discovery: everything
-- needed for both is already inside responses we fetch and throw away. Neither
-- costs a single additional upstream request.
--
--
-- ODDS -- and why it has to be a snapshot rather than a lookup.
--
-- The scoreboard carries `competitions[].odds[]`: a spread, a total, a moneyline
-- each way, and which side the book makes favourite. That response is already
-- fetched every sync pass for every league, so reading it is free.
--
-- It is only there while the game is `pre`. Measured against the live API
-- 2026-09-06: NFL 16/16, WNBA 5/5 and college football 4/4 of the pre games each
-- carried a line -- and all 21 finished college football games, all 15 finished
-- MLB games and both finished soccer fixtures carried `odds: null` or a list whose
-- only entry is null. The book stops pricing a game once it starts, and ESPN drops
-- the field with it.
--
-- So the line cannot be read on demand for the page that most wants it, which is
-- the recap. It has to be written down before kickoff and kept. That is what makes
-- this a column rather than a join: `coalesce(excluded.odds, events.odds)` in
-- upsertEvents means the sync that runs after kickoff -- carrying a null where the
-- line used to be -- cannot erase what the pre-kickoff pass captured.
--
-- jsonb rather than columns, following score_detail (0029). A moneyline is a US
-- convention, a fractional price is a British one, soccer prices a draw and most
-- sports do not, and the set of books differs per league. The shape written by
-- packages/sports/src/espn.js oddsFromCompetition:
--
--   {"provider":"DraftKings",
--    "details":"SEA -3.5",        -- the book's own phrasing, always shown as-is
--    "spread":-3.5,               -- signed toward the HOME side
--    "overUnder":44.5,
--    "favorite":"home",           -- "home" | "away" | null (a pick'em, or no line)
--    "homeMoneyline":-175,
--    "awayMoneyline":145,
--    "drawMoneyline":null,        -- soccer only
--    "capturedAt":"2026-09-06T...",
--    "capturedState":"pre"}       -- so the page can say "closing line" honestly
--
-- Nullable, and null for the large majority of rows: books price a few dozen
-- leagues out of 354. Nothing reading it may assume it is present.
alter table events add column if not exists odds jsonb;


-- RECAP -- the box score, and where it was hiding.
--
-- The play poller reads a ~500KB summary per fixture and keeps only the plays. The
-- comment above fetchPlays has said so since it was written: "carries a boxscore,
-- rosters, odds and news we do not use". It also carries per-period linescores,
-- the officials, the attendance, the game duration and -- for the leagues an agency
-- covers -- an AP recap with a real headline and first paragraph.
--
-- A finished game is already read exactly once more after the whistle, to catch the
-- plays between the last poll and full time (see 0011_plays_final.sql). Storing the
-- rest of that same response is therefore free: no new request, no new quota, no
-- new proxy bandwidth. It was being parsed and discarded.
--
-- The shape written by recapFromSummary:
--
--   {"linescores":{"labels":["1","2","3","4"],
--                  "away":["7","3","14","0"], "home":["0","10","7","3"]},
--    "teamStats":[{"label":"Total Yards","away":"312","home":"401"}, ...],
--    "leaders":[{"team":"away","name":"...","line":"18/27, 241 YDS, 2 TD"}, ...],
--    "officials":["..."], "duration":"3:12", "attendance":41893,
--    "article":{"headline":"...","summary":"...","source":"AP","publishedAt":"..."}}
--
-- Every key is optional and the renderer draws only what is present. That is not
-- defensiveness for its own sake: the sports differ enormously in what they return
-- (measured 2026-09-06, one finished fixture each) and a renderer that assumed any
-- one key would be blank for most of the catalogue.
alter table events add column if not exists recap jsonb;

-- Set by the read that writes a recap, and the only thing that closes the recap
-- queue. Deliberately NOT inferred from `recap is not null`: a fixture whose
-- summary genuinely has no box score would then be re-read on every pass forever,
-- which is the exact failure 0011 was written to stop. A row that has been looked
-- at is done with whether or not it yielded anything.
alter table events add column if not exists recap_synced_at timestamptz;


-- Which leagues can have a box score at all.
--
-- `plays_supported` (0012) is the wrong gate for this and using it would have been
-- the bug. Six of the ten sports it excludes return a boxscore and nothing else --
-- so gating recaps on it would deny a box score to precisely the sports where the
-- box score is the only thing there is. Measured 2026-09-06, one finished fixture
-- per sport, `boxscore.teams` / `boxscore.players`:
--
--   volleyball 2/2, water-polo 2/2, field-hockey 2/2, rugby-league 2/2,
--   australian-football 2/2, college football 2/2, lacrosse 0/0 but with
--   per-period linescores
--
-- What genuinely has nothing is the other four, and for the same reason as in 0012:
-- for tennis, golf, racing and mma a scoreboard event is a tournament, a race
-- weekend or a fight card, and the summary endpoint wants an individual match. It
-- answers 400 or 404 for the id we store. Those are excluded by sport, not guessed
-- at per league.
--
-- Default true, so a sport added later gets a recap by default and only has to be
-- turned off if it turns out to have nothing -- the opposite default from
-- plays_supported, because a box score is much more widely available than a play
-- log.
alter table leagues add column if not exists boxscore_supported boolean not null default true;

update leagues set boxscore_supported = false
 where sport in ('tennis', 'golf', 'racing', 'mma');

-- The recap queue's predicate, matching eventsNeedingRecap. Partial, because the
-- rows it excludes are almost all of them: everything not yet finished, and
-- everything already read.
create index if not exists events_recap_due_idx
  on events (starts_at desc)
  where state = 'post' and recap_synced_at is null;

-- Browsing finished games, which nothing could do before this. /results, and the
-- "Recent results" block on a league page, both order by kickoff descending within
-- a league; the partial predicate keeps the index to the finished rows only.
create index if not exists events_results_idx
  on events (league_id, starts_at desc)
  where state = 'post';
