-- Letting one account's SiriusXM line be listened to by the others.
--
-- The radio counterpart of 0024 and 0027: the same three audiences, the same
-- named-people grants, the same default of nobody. What the owner is agreeing to
-- differs in one way that makes this SAFER than sharing a playlist, and the UI
-- says so: nothing that leaves the server is the credential. A SiriusXM session
-- is a bearer and a cookie jar that never reach a page; other people hear the
-- audio through us, as media-streamer's restream rail does, and every listener on
-- a channel shares one upstream fetch, so a line carries one connection per
-- channel no matter how many are listening.
--
-- Written together, always, and the constraint says so: a row that is shared
-- has an audience that is not 'none', and a row that is not has 'none'.
alter table siriusxm_sessions
  add column if not exists shared boolean not null default false;
alter table siriusxm_sessions
  add column if not exists share_audience text not null default 'none';
alter table siriusxm_sessions
  add column if not exists shared_at timestamptz;
-- What other people see instead of the owner's SiriusXM email, which is exactly
-- the thing not to publish. Null falls back to the owner's handle.
alter table siriusxm_sessions
  add column if not exists shared_label text;

alter table siriusxm_sessions drop constraint if exists siriusxm_sessions_audience_agrees;
alter table siriusxm_sessions add constraint siriusxm_sessions_audience_agrees
  check (
    (shared and share_audience in ('friends', 'everyone'))
    or (not shared and share_audience = 'none')
  );

create index if not exists siriusxm_sessions_shared_idx
  on siriusxm_sessions (user_id) where shared;

-- Named people, rather than a rule that infers them. Same reasoning as 0027: a
-- follow is not consent, so the owner names who, and the row exists until they
-- remove it. Keyed by the owner's account, since a line is one row per account.
create table if not exists siriusxm_share_grants (
  owner_user_id    uuid not null references siriusxm_sessions(user_id) on delete cascade,
  audience_user_id uuid not null references users(id) on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (owner_user_id, audience_user_id)
);

create index if not exists siriusxm_share_grants_audience_idx
  on siriusxm_share_grants (audience_user_id);
