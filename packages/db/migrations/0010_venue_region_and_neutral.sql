-- Where a game is, and which side is at home.
--
-- The venue was a bare name: "PNC Park" tells a Pittsburgh fan everything and
-- everyone else nothing. ESPN already sends the city with a state (US) or a
-- country (everywhere else), so both are stored as one region field rather than
-- two columns only one of which is ever populated.
--
-- neutral_site matters because the whole home/away idea stops being true for it:
-- a World Cup group game, an NFL game in London or a bowl game still names a home
-- side in the feed, and labelling it "Home" on the page would be a lie.
alter table events add column if not exists venue_region text;
alter table events add column if not exists neutral_site boolean not null default false;
