-- Every market a fixture is carried in, not just the biggest one.
--
-- 0013 stored a single country and a comma-joined string of its channels, which
-- throws away most of the answer: a Champions League tie is on CBS and Paramount+
-- in the US, TNT in the UK and beIN in France, and picking whichever market had the
-- most entries meant three quarters of readers were shown a channel they cannot
-- watch. The page now offers a tab per country, so the shape has to survive.
--
-- jsonb rather than a broadcast_markets table. It is read whole, written whole, and
-- only ever on the way to one page -- there is no query that wants to filter or join
-- on an individual channel, and a child table would add a second write and a join to
-- every event read for nothing.
--
-- Shape: [{"country": "United Kingdom", "channels": ["Sky Sports", "TNT Sports"]}]
-- ordered with the most-covered market first.
alter table events add column if not exists broadcast_markets jsonb;

-- The flat columns stay. `broadcast` is what the RSS descriptions, the ICS
-- summaries and the reminder emails read, and none of those has anywhere to put a
-- tab strip -- so it keeps holding the primary market's channels, and this column
-- carries the rest. Dropping it would have meant rewriting four renderers to say
-- the same sentence.
comment on column events.broadcast_markets is
  'All markets: [{country, channels[]}], most-covered first. events.broadcast holds the primary one flattened, for the feeds.';

-- Backfill from what 0013 already stored, so a row that has a listing today does
-- not render an empty picker until its league is swept again.
update events
   set broadcast_markets = jsonb_build_array(
         jsonb_build_object(
           'country', coalesce(broadcast_country, 'International'),
           -- Splitting the joined string is lossy in theory and exact in practice
           -- for every value we have ever written; the next sweep replaces it with
           -- the real list either way.
           'channels', to_jsonb(string_to_array(broadcast, ', '))
         )
       )
 where broadcast is not null
   and broadcast_markets is null;
