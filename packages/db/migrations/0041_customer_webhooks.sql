-- Customer webhooks: a reader's own URL, called signed when a game they follow is
-- about to start, starts, finishes, or its betting line moves.
--
-- The first two tables are @profullstack/webhooks' own, verbatim from its
-- schemaSql('pg') (test/webhooks.test.js fails if they drift apart). The package
-- owns endpoints, signing keys, event filters, the durable outbox with its
-- backoff, and the delivery log. `owner` is users.id as text.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '["*"]',
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      failures INTEGER NOT NULL DEFAULT 0,
      disabled_reason TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

CREATE INDEX IF NOT EXISTS webhook_endpoints_owner ON webhook_endpoints(owner);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at BIGINT NOT NULL,
      last_status INTEGER,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_at);

CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at);

-- What the scanner (packages/webhooks/src/scan.js) has already announced.
--
-- Game state is written by two hot paths (the sweep's upsertEvents and the
-- minute-by-minute live tick) and neither knows the state it overwrote, so a
-- transition cannot be caught where it happens without slowing both. Instead the
-- scanner looks for fixtures in a state worth announcing and claims each
-- (kind, ref) here first: the insert ... on conflict do nothing returning is what
-- makes an announcement happen once, however many scanners run and however often.
-- `ref` is events.id for the game.* kinds and event_odds_snapshots.id for
-- line.moved. Pruned after a week; nothing older can be announced again because
-- every scan window is hours, not days.
create table if not exists webhook_marks (
  kind       text not null,
  ref        bigint not null,
  created_at timestamptz not null default now(),
  primary key (kind, ref)
);
create index if not exists webhook_marks_created_idx on webhook_marks (created_at);

-- The per-account hourly allowance. A reader who follows every league sees
-- hundreds of line moves an hour; past the cap the rest of that hour is dropped
-- rather than queued, so one account cannot fill the outbox.
create table if not exists webhook_rate (
  owner text not null,
  kind  text not null,
  hour  timestamptz not null,
  n     int not null default 0,
  primary key (owner, kind, hour)
);

-- A personal API key: what /api/v1/webhooks takes from a script. One per
-- account; only the hash is stored, so the key is shown once, on creation.
create table if not exists api_keys (
  user_id      uuid primary key references users(id) on delete cascade,
  key_hash     bytea not null unique,
  hint         text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
