-- People, not just teams: profiles, following each other, and direct messages.
--
-- NOT an extension of `follows`. That table's subject_id is a bigint, because a
-- team and a league are bigserial; a user is a uuid. Widening it to text to carry
-- both would make every existing follow query cast on both sides and lose its
-- index, so following a person gets its own table with its own foreign keys --
-- which also means the database can enforce that a followee is a real account,
-- something the polymorphic table cannot do for any of its subjects.

-- A handle is what a profile URL is built from, and it is deliberately NOT derived
-- from the email address. Doing that would publish the local part of everyone's
-- address the moment profiles shipped -- anthony@… becomes /u/anthony -- which is
-- a privacy leak dressed up as a convenience. So it is null until someone chooses
-- one, and an account without a handle simply has no public profile yet.
alter table users add column if not exists handle       citext unique;
alter table users add column if not exists display_name text;
alter table users add column if not exists bio          text;

-- Opt-out rather than opt-in: the site is a public directory of fixtures and a
-- profile shows nothing an account did not choose to put there. Someone who wants
-- to disappear can, and the profile route honours it for everyone but the owner.
alter table users add column if not exists profile_public boolean not null default true;

create table if not exists user_follows (
  follower_id uuid not null references users(id) on delete cascade,
  followee_id uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  -- Following yourself is not a state worth supporting anywhere downstream.
  constraint user_follows_not_self check (follower_id <> followee_id)
);
-- "Who follows this person" is the follower list on a profile, and the primary key
-- only serves the other direction.
create index if not exists user_follows_followee_idx on user_follows (followee_id);

-- A block is one-directional and beats everything else: it stops messages and
-- hides the blocker from the blocked account's view of a follower list.
create table if not exists user_blocks (
  blocker_id uuid not null references users(id) on delete cascade,
  blocked_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);

create table if not exists messages (
  id           bigserial primary key,
  sender_id    uuid not null references users(id) on delete cascade,
  recipient_id uuid not null references users(id) on delete cascade,
  body         text not null check (length(btrim(body)) between 1 and 4000),
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  constraint messages_not_self check (sender_id <> recipient_id)
);

-- A thread is "everything between these two people, either direction", so both
-- orderings need an index or half of every conversation is a sequential scan.
create index if not exists messages_thread_idx
  on messages (sender_id, recipient_id, created_at desc);
create index if not exists messages_thread_rev_idx
  on messages (recipient_id, sender_id, created_at desc);

-- The unread badge is a count over one person's inbox, and it is read on every
-- page load, so it gets a partial index sized to the unread rows rather than the
-- whole table.
create index if not exists messages_unread_idx
  on messages (recipient_id)
  where read_at is null;
