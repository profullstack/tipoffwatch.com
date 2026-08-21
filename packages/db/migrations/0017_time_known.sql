-- Whether an event's start time is a real clock time or a date we padded.
--
-- Sports made this easy to ignore: a fixture has a kickoff, so `starts_at` always
-- meant something to the minute. It is not actually always true even here -- a
-- playoff game is scheduled before its slot is sold, a rain-affected fixture is
-- "Saturday, time TBD", and ESPN pads those to midnight local, which we then
-- render as a real time and remind people about an hour before. That is already
-- wrong today; it is just rare enough not to have been noticed.
--
-- It stops being rare the moment this codebase serves anything other than sport.
-- A film opens on a Friday, an album is out on a Tuesday, and nobody publishes an
-- hour for either -- so a sibling brand running on this schema needs the flag to
-- exist, and sport benefits from it on the way past.
--
-- Additive and defaulted to true, because every fixture already stored DOES have a
-- kickoff. Nothing changes for existing rows or existing queries.
alter table events add column if not exists time_known boolean not null default true;

-- second | minute | hour | day | month | year, from the provider where it says so.
-- Kept alongside time_known because "day" and "year" are both untimed and only one
-- of them is worth putting on a page -- and because a month- or year-precision
-- date must never trigger a reminder at all.
alter table events add column if not exists precision text not null default 'minute';

-- The reminder scanner runs one pass per class, and each wants only its own half.
create index if not exists events_upcoming_timed_idx
  on events (starts_at)
  where state = 'pre' and time_known;

-- Minutes before an event that only has a DATE.
--
-- A separate list from offsets_minutes because the sensible answers differ by two
-- orders of magnitude: an hour before a kickoff, the morning of a release. Feeding
-- one list to the other class is how you tell someone their album "starts in 60
-- minutes" at 11:00, against a noon anchor nobody chose.
alter table reminder_prefs
  add column if not exists date_offsets_minutes int[] not null default '{1440,0}';
