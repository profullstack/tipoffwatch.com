-- A per-user secret for calendar subscriptions.
--
-- Calendar clients (Google, Apple, Outlook) fetch a URL on a schedule with no
-- cookies and no way to sign in, so the URL itself has to carry the authority. A
-- random token per user means a leaked link exposes one person's fixture list and
-- can be rotated without touching their session or password -- which is why it is
-- a separate secret rather than reusing the session id.
alter table users add column if not exists calendar_token uuid not null default gen_random_uuid();

create unique index if not exists users_calendar_token_idx on users (calendar_token);
