-- Paid streams. A seller lists access they already hold with an IPTV provider and
-- resells it per game; a buyer gets an entitlement scoped to one event.
--
-- Deliberately provider-agnostic: nothing here names an IPTV vendor, because the
-- upstream (bittorrented.com's shared provider pool) hands back an opaque playback
-- reference that we store and never interpret.

create table stream_offers (
  id             bigserial primary key,
  event_id       bigint not null references events(id) on delete cascade,
  seller_user_id uuid not null references users(id) on delete cascade,
  -- Opaque handle for the upstream provider slot. Never rendered to a buyer.
  provider_ref   text not null,
  price_cents    int not null check (price_cents >= 0),
  currency       text not null default 'USD',
  -- How many concurrent viewers this slot can carry. Overselling a provider slot
  -- is the failure everyone notices at kickoff, so capacity is enforced, not advisory.
  capacity       int not null default 1 check (capacity > 0),
  sold           int not null default 0 check (sold >= 0),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  constraint stream_offers_not_oversold check (sold <= capacity)
);
create index stream_offers_event_idx on stream_offers (event_id) where active;
create index stream_offers_seller_idx on stream_offers (seller_user_id);

create table payments (
  id           bigserial primary key,
  user_id      uuid not null references users(id) on delete cascade,
  provider     text not null default 'coinpay',
  -- The provider's own id. Unique so a replayed webhook credits nothing twice.
  provider_ref text not null,
  amount_cents int not null,
  currency     text not null default 'USD',
  status       text not null default 'pending',
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, provider_ref)
);
create index payments_user_idx on payments (user_id);

create table entitlements (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  event_id   bigint not null references events(id) on delete cascade,
  offer_id   bigint references stream_offers(id) on delete set null,
  payment_id bigint references payments(id) on delete set null,
  status     text not null default 'active',
  -- Access dies with the game plus a grace window; there is no perpetual licence
  -- to a live stream, and an open-ended grant is what turns a $1 sale into piracy.
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- One entitlement per person per game: re-buying is a no-op, not a double charge.
  unique (user_id, event_id)
);
create index entitlements_event_idx on entitlements (event_id);
create index entitlements_expiry_idx on entitlements (expires_at) where status = 'active';
