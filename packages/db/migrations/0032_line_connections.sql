-- How many streams one line permits at once.
--
-- The proxy has capped every account at ONE open stream since it existed, and
-- evicts the older one when a second starts. That is why "play in a new tab and
-- the old tab stops": it is the server protecting the reader's subscription,
-- because a typical provider line suspends an account that opens two connections.
-- But it is a fact about the LINE, not about the site, and many lines are sold
-- with two, three or five connections. A reader on one of those was being held
-- to a limit their provider never set.
--
-- Two columns, and they answer different questions:
--
--   panel_connections  what the provider's own panel SAYS the line permits. Read
--                      from the Xtream `player_api.php` endpoint at import and on
--                      every refresh; null when the address is not an Xtream
--                      panel, or the panel would not say.
--   line_connections   what the reader chose in settings. Null means "whatever
--                      my provider reports, else one".
--
-- The allowance the proxy enforces is the smaller of the two (and the site
-- ceiling in config): the reader can lower what the panel permits but never
-- raise it, because exceeding it is what gets their account suspended. A check
-- constraint keeps the chosen value in the range the picker offers.
alter table user_playlists
  add column if not exists line_connections int
    check (line_connections is null or line_connections between 1 and 8);

alter table user_playlists
  add column if not exists panel_connections int
    check (panel_connections is null or panel_connections >= 0);

-- The rest of what the panel said, because it answers "why does my line say
-- Expired" without another round trip. Nothing enforces on these.
alter table user_playlists
  add column if not exists panel_active int;

alter table user_playlists
  add column if not exists panel_status text;

alter table user_playlists
  add column if not exists panel_expires_at timestamptz;

alter table user_playlists
  add column if not exists panel_checked_at timestamptz;
