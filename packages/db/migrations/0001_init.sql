-- Accounts. Magic link + passkey only: there is no password column on purpose,
-- so there is nothing to reset, rotate or leak.
create extension if not exists citext;
create extension if not exists pg_trgm;

create table users (
  id           uuid primary key default gen_random_uuid(),
  email        citext not null unique,
  timezone     text not null default 'UTC',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

-- Magic links. Only the hash is stored, so a database read cannot mint a session.
create table login_tokens (
  token_hash  bytea primary key,
  email       citext not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
create index login_tokens_expires_idx on login_tokens (expires_at);

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

create table passkeys (
  credential_id text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_user_idx on passkeys (user_id);

-- Catalogue. provider + provider_key is the natural key from whichever adapter
-- supplied the row, so two adapters can describe the same league without collision.
create table leagues (
  id           bigserial primary key,
  provider     text not null,
  provider_key text not null,
  sport        text not null,
  slug         text not null unique,
  name         text not null,
  abbreviation text,
  logo_url     text,
  -- Drives polling cadence: hand-tuned for leagues people actually follow.
  priority     int not null default 100,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (provider, provider_key)
);
create index leagues_sport_idx on leagues (sport) where active;

create table teams (
  id           bigserial primary key,
  provider     text not null,
  provider_key text not null,
  league_id    bigint references leagues(id) on delete set null,
  slug         text not null unique,
  name         text not null,
  display_name text not null,
  abbreviation text,
  logo_url     text,
  created_at   timestamptz not null default now(),
  unique (provider, provider_key)
);
create index teams_league_idx on teams (league_id);
-- Powers the follow picker's search box.
create index teams_name_trgm_idx on teams using gin (display_name gin_trgm_ops);

create table events (
  id            bigserial primary key,
  provider      text not null,
  provider_key  text not null,
  league_id     bigint not null references leagues(id) on delete cascade,
  starts_at     timestamptz not null,
  -- pre | in | post, normalised across adapters.
  state         text not null default 'pre',
  status_detail text,
  name          text not null,
  short_name    text,
  venue         text,
  home_team_id  bigint references teams(id) on delete set null,
  away_team_id  bigint references teams(id) on delete set null,
  home_score    int,
  away_score    int,
  updated_at    timestamptz not null default now(),
  unique (provider, provider_key)
);
create index events_starts_at_idx on events (starts_at);
create index events_league_starts_idx on events (league_id, starts_at);
-- The reminder scheduler's hot query: upcoming events only, newest schema first.
create index events_upcoming_idx on events (starts_at) where state = 'pre';
create index events_home_idx on events (home_team_id, starts_at);
create index events_away_idx on events (away_team_id, starts_at);

-- Following. subject_type lets one table carry both team and league follows, which
-- keeps the fan-out query a single union rather than two divergent code paths.
create table follows (
  user_id      uuid not null references users(id) on delete cascade,
  subject_type text not null check (subject_type in ('team', 'league')),
  subject_id   bigint not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, subject_type, subject_id)
);
create index follows_subject_idx on follows (subject_type, subject_id);

create table reminder_prefs (
  user_id         uuid primary key references users(id) on delete cascade,
  offsets_minutes int[] not null default '{60,1}',
  channels        text[] not null default '{webpush,email}',
  updated_at      timestamptz not null default now()
);

create table push_subscriptions (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  -- Set when the push service answers 404/410. Kept rather than deleted so a
  -- resubscribe from the same browser is visible as a repair, not a new device.
  disabled_at timestamptz
);
create index push_subs_user_idx on push_subscriptions (user_id) where disabled_at is null;

-- At-most-once delivery. The primary key IS the idempotency guard: a retried or
-- duplicated fan-out job cannot send the same person the same reminder twice.
create table reminder_deliveries (
  event_id       bigint not null references events(id) on delete cascade,
  user_id        uuid not null references users(id) on delete cascade,
  offset_minutes int not null,
  channel        text not null,
  status         text not null default 'sent',
  sent_at        timestamptz not null default now(),
  primary key (event_id, user_id, offset_minutes, channel)
);
create index reminder_deliveries_sent_idx on reminder_deliveries (sent_at);
