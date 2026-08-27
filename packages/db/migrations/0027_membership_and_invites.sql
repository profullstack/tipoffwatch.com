-- Premium membership, the invite chain that pays a commission on it, and the
-- narrower kind of sharing it unlocks.
--
-- Three features arrive together because they are one product: a paid tier, the
-- thing it sells, and the reason an existing member brings somebody else in. They
-- are separated below only so the constraints can be read next to what they guard.

/* ------------------------------------------------------------------ invites -- */

-- Column names and semantics taken verbatim from genrewatch's 0009_invites.sql,
-- which shipped this first. Same shapes on both sides so a fix ports as a diff
-- rather than as a translation.

-- The personal code in an invite link. Null until the reader first asks for one --
-- minting one for every account would create a few hundred thousand secrets nobody
-- asked for and most would never use.
alter table users add column if not exists invite_code text unique;

-- Who brought whom. The primary key is the INVITED user, which makes "you can only
-- be invited once, by one person" a property of the schema rather than of the code
-- that writes it. That matters more here than it did upstream: this row is what a
-- commission is paid against, so a second one would be a second payout.
create table if not exists invite_claims (
  invited_user_id uuid primary key references users(id) on delete cascade,
  inviter_id      uuid not null references users(id) on delete cascade,
  claimed_at      timestamptz not null default now(),
  constraint invite_claims_not_self check (invited_user_id <> inviter_id)
);

create index if not exists invite_claims_inviter_idx
  on invite_claims (inviter_id, claimed_at desc);

-- Every invite email sent on somebody's behalf. This exists to be counted: without
-- a per-account cap an "invite your friends" form is an open relay with our domain
-- on the envelope, and the bill is paid in the deliverability of every reminder we
-- send to everybody else. The address is recorded so a repeat send can be refused
-- quietly rather than turned into a way to badger somebody who ignored the first.
create table if not exists invite_sends (
  id         bigserial primary key,
  inviter_id uuid not null references users(id) on delete cascade,
  email      citext not null,
  sent_at    timestamptz not null default now()
);

create index if not exists invite_sends_inviter_idx on invite_sends (inviter_id, sent_at desc);
create index if not exists invite_sends_email_idx   on invite_sends (email, sent_at desc);

/* -------------------------------------------------------------- membership -- */

-- One row per TERM PAID FOR, not one row per member.
--
-- A renewal is a new row, and "are they a member" is `max(expires_at) > now()`.
-- Storing a single mutable row per account and moving its expiry forward would
-- lose the thing an accounting question actually needs -- which payment bought
-- which stretch of time -- and would make a replayed webhook indistinguishable
-- from a genuine renewal.
create table if not exists memberships (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  -- Unique, and that is the whole idempotency story: `payments` is already unique
  -- on (provider, provider_ref), so a webhook replayed ten times updates one
  -- payment row and can insert exactly one term against it.
  payment_id bigint unique references payments(id) on delete set null,
  status     text not null default 'active',
  started_at timestamptz not null default now(),
  -- Never null. A membership with no expiry is a perpetual grant nobody decided to
  -- make, and there is no code path that should be able to create one.
  expires_at timestamptz not null,
  price_cents int not null check (price_cents >= 0),
  currency   text not null default 'USD',
  created_at timestamptz not null default now(),
  constraint memberships_term_forwards check (expires_at > started_at)
);

-- The read is "is this person a member", on nearly every page a member loads.
create index if not exists memberships_user_idx on memberships (user_id, expires_at desc);

/* ------------------------------------------------------------- commissions -- */

-- What an inviter earned, one row per payment made by somebody they invited.
--
-- `payment_id` is unique and NOT NULL. That single constraint is what makes a
-- commission un-double-payable: the webhook that settles a payment is retried by
-- the upstream until it gets a 200, and crediting on each retry is how a $10 sale
-- pays out $10.
create table if not exists referral_commissions (
  id          bigserial primary key,
  referrer_id uuid not null references users(id) on delete cascade,
  buyer_id    uuid not null references users(id) on delete cascade,
  payment_id  bigint not null unique references payments(id) on delete cascade,
  amount_cents int not null check (amount_cents >= 0),
  -- Stored per row rather than read from configuration at payout time. The rate
  -- somebody was promised when they made the introduction is not a setting that
  -- gets to change retroactively.
  rate_bps    int not null check (rate_bps between 0 and 10000),
  currency    text not null default 'USD',
  -- accrued -> paid. Nothing here pays anybody: there is no automated payout rail,
  -- so this is a ledger a human settles from.
  status      text not null default 'accrued',
  paid_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint referral_commissions_not_self check (referrer_id <> buyer_id)
);

create index if not exists referral_commissions_referrer_idx
  on referral_commissions (referrer_id, created_at desc);

-- Where an inviter wants their commission sent, and on which chain.
--
-- Both or neither: an address without a chain is not a payee. A BTC address is not
-- somewhere an ETH payout can land, so the pair travels together or the account
-- simply has no payout instruction yet and nothing is sent anywhere.
alter table users add column if not exists payout_address text;
alter table users add column if not exists payout_chain   text;
alter table users drop constraint if exists users_payout_pair;
alter table users add constraint users_payout_pair
  check ((payout_address is null) = (payout_chain is null));

/* ---------------------------------------------------- sharing with friends -- */

-- Who a shared list is shared WITH.
--
-- 0024 added `shared`, a boolean meaning "everybody signed in". That is still
-- exactly what it means, and every account already sharing keeps doing so -- the
-- backfill below says so. What is new is a second, narrower audience for people
-- who want the feature without publishing their provider line to the whole site.
--
-- The two columns are kept in step by a constraint rather than by discipline. A
-- row where `shared` is true and the audience is 'none' is unreachable, and a row
-- where it is false and the audience is not is a list that some query somewhere
-- will eventually treat as open.
alter table user_playlists
  add column if not exists share_audience text not null default 'none';

update user_playlists set share_audience = 'everyone' where shared and share_audience = 'none';

alter table user_playlists drop constraint if exists user_playlists_audience_agrees;
alter table user_playlists add constraint user_playlists_audience_agrees
  check (
    (shared and share_audience in ('friends', 'everyone'))
    or (not shared and share_audience = 'none')
  );

-- Named people, rather than a rule that infers them.
--
-- A follow is not consent to hand over a credential. Somebody who follows back out
-- of politeness has not agreed to be able to open the owner's provider line, and a
-- mutual-follow rule would mean the audience for a credential changes every time
-- somebody presses a button on an unrelated page. So the owner names who, and the
-- row exists until they remove it.
create table if not exists playlist_share_grants (
  playlist_id      bigint not null references user_playlists(id) on delete cascade,
  audience_user_id uuid not null references users(id) on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (playlist_id, audience_user_id)
);

-- The read is "which lists am I allowed to see", once per viewer per page.
create index if not exists playlist_share_grants_audience_idx
  on playlist_share_grants (audience_user_id);
