import * as auth from '@tipoff/auth';
import * as invites from '@tipoff/auth/invites';
import { brand, config, href } from '@tipoff/config';
import * as q from '@tipoff/db/queries';
import { sendInviteEmail, sendLoginLink } from '@tipoff/notify';
import * as pay from '@tipoff/payments';
import * as member from '@tipoff/payments/membership';
import {
  claimStreamSlot,
  firstLiveChannel,
  importPlaylist,
  marketChannelsForEvent,
  maskPlaylistUrl,
  openStream,
  ownChannelsForEvent,
  ownChannelsForTeam,
  playlistSource,
  probeStream,
  refreshPlaylist,
  sharedChannelsForEvent,
  streamSlotsOpen,
  verdictToStore,
} from '@tipoff/playlists';
import { connection } from '@tipoff/queue';
import * as radio from '@tipoff/radio';
import { oneChannelM3u, searchEverything } from '@tipoff/sports';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { assetUrl, isCurrentVersion, loadAssetVersions } from './lib/asset-version.js';
import { attempt, callerAddress, forgive, MISS, VIEW } from './lib/auth-throttle.js';
import { buildCalendar } from './lib/ics.js';
import { buildFeed } from './lib/rss.js';
import { SECURITY_HEADERS } from './lib/security-headers.js';
import { llmsTxt, robotsTxt, securityTxt, skillMd } from './lib/well-known.js';
import { Feeds } from './views/feeds.jsx';
import { Contact, Privacy, Terms } from './views/legal.jsx';
import {
  About,
  Channels,
  EventPage,
  Following,
  Landing,
  LeaguePage,
  marketsOf,
  NotFound,
  PushCheck,
  SearchPage,
  Settings,
  SharedLists,
  SignIn,
  SportPage,
  SportsIndex,
  TeamPage,
  WatchPage,
} from './views/pages.jsx';
import { Inbox, PeopleListPage, ProfilePage, Thread } from './views/people.jsx';
import { InvitePage, PremiumPage } from './views/premium.jsx';
import { RadioPage, RadioSidesFragment } from './views/radio.jsx';

export const app = new Hono();

/* ----------------------------------------------------------------- helpers -- */

/**
 * Answer the caller in its own language.
 *
 * Every control on the site is a plain form, so the browser gets a 303 back to
 * where it came from and the page works with JavaScript off. A caller that asked
 * for JSON gets JSON. One helper, so the two can never drift apart.
 */
/**
 * Is this account a member right now?
 *
 * One function, called by every gate, so the three features premium sells cannot
 * drift apart in what they consider a member. It reads the terms table rather than
 * a flag on the account: there is no `users.is_premium` to fall out of step with
 * what was actually paid for.
 */
async function isMember(user) {
  if (!user?.id) return false;
  return Boolean(await q.activeMembership(user.id));
}

/**
 * How far back this reader may read their own messages, in days.
 *
 * Null means "all of it". The window is a product decision and it is made HERE,
 * once, rather than inside the query -- which stays a query with a parameter
 * instead of one that knows about money.
 */
function historyWindowDays(member) {
  if (member) return null;
  const days = config.membership.freeMessageHistoryDays;
  return days > 0 ? days : null;
}

function respond(c, { json, redirectTo, status }) {
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('application/json') || c.req.header('x-requested-with') === 'fetch') {
    // A status only makes sense on the JSON branch: the form path carries failure
    // in the query string it redirects to, because a 400 there would replace the
    // settings page with a bare error instead of showing it in context.
    return c.json(json ?? { ok: true }, status ?? 200);
  }
  return c.redirect(redirectTo ?? c.req.header('referer') ?? '/', 303);
}

/**
 * Render a page.
 *
 * Every HTML response goes through here for one reason: hono/jsx does not emit a
 * doctype, and a page served without one puts the browser in quirks mode, where
 * the box model and several of this stylesheet's assumptions quietly change.
 * Centralising it is the only way it cannot be forgotten on the one route nobody
 * checks.
 */
export const render = async (node) => `<!doctype html>${await node.toString()}`;

/**
 * Crawlers that are not welcome here at all.
 *
 * AwarioBot was 47% of all requests to tipoffwatch, fetching /login about once a
 * second from a single address. It was told to stop in robots.txt, re-read that
 * file, and carried on -- so being polite about it is finished. It is a
 * brand-monitoring crawler: it sends nobody here and there is nothing on this
 * site it needs.
 *
 * Matched on the user agent, which a determined caller can lie about. That is
 * fine, and worth being clear about: this is here to stop a self-identifying bot
 * that is merely rude, not to stop somebody hostile. Anything that lies its way
 * past this still meets the backoff below.
 *
 * 403 rather than 429, because there is no wait that would make this allowed.
 */
const BLOCKED_AGENTS = ['awariobot'];

app.use('*', async (c, next) => {
  const ua = (c.req.header('user-agent') ?? '').toLowerCase();
  if (BLOCKED_AGENTS.some((bot) => ua.includes(bot))) {
    return c.text('Not available to this crawler.', 403);
  }
  return next();
});

/*
 * Security headers, on everything.
 *
 * Registered before any route so it covers the assets and the feeds too, not just
 * the pages -- `nosniff` on a stylesheet is the half of it people forget. The
 * policy itself lives in lib/security-headers.js next to the hash of the one
 * inline script it has to allow.
 */
app.use('*', async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
});

app.use('*', async (c, next) => {
  const sid = getCookie(c, config.session.cookie);
  const user = sid ? await auth.userFromRequest(sid) : null;

  // The unread badge hangs off the user rather than being threaded through every
  // view's props: the header is on every page, and passing it explicitly would
  // mean touching a dozen render calls to add one number. One indexed count on a
  // partial index, and only for signed-in requests -- which are never cached, so
  // it cannot end up in a shared page.
  if (user) {
    user.unread = await q.unreadMessageCount(user.id).catch(() => 0);
  }
  c.set('user', user);
  await next();
});

/** Signed-out actions send you to sign in and come back, rather than erroring. */
function requireUser(c) {
  const user = c.get('user');
  if (!user) {
    const next = encodeURIComponent(c.req.path);
    throw Object.assign(new Error('auth required'), { redirect: `/login?next=${next}` });
  }
  return user;
}

app.onError((err, c) => {
  if (err.redirect) return c.redirect(err.redirect, 303);
  console.error('[web]', err);
  return c.json({ error: 'internal' }, 500);
});

/* --------------------------------------------------------------- read path -- */

/**
 * Schedule pages are byte-identical for every visitor, so they are rendered once
 * and served from Redis. This is the difference between a viral spike hitting one
 * cache and hitting Postgres once per reader.
 */
async function cached(c, key, ttl, produce) {
  // Only ever cache what is identical for everyone. A signed-in page carries follow
  // stars and the visitor's own timezone, so it is rendered fresh -- caching it would
  // serve one person's calendar to the next visitor.
  if (!config.cache.enabled || c.get('user')) {
    // And say so out loud. Without this header an intermediary is free to apply
    // its own default heuristic to a page with somebody's follow list on it.
    if (c.get('user')) c.header('cache-control', 'private, no-store');
    return c.html(await produce());
  }

  /*
   * The same TTL the render is held for, offered to everyone downstream.
   *
   * There was no Cache-Control at all, so every crawler and CDN had to guess --
   * and a crawler that guesses conservatively re-fetches a page that has not
   * changed, which for a site whose homepage is one Redis read is pure waste on
   * both sides. `s-maxage` lets a shared cache hold it for the full window while
   * a browser revalidates sooner.
   */
  c.header('cache-control', `public, max-age=${Math.min(ttl, 60)}, s-maxage=${ttl}`);

  try {
    const hit = await connection.get(key);
    if (hit) {
      c.header('x-cache', 'hit');
      return c.html(hit);
    }
  } catch {
    // A Redis blip must not take the site down; fall through to the database.
  }

  const body = await produce();
  connection.set(key, body, 'EX', ttl).catch(() => {});
  c.header('x-cache', 'miss');
  return c.html(body);
}

app.get('/healthz', (c) => c.text('ok'));

/*
 * Categories this brand does not carry, and where to send people instead.
 *
 * Declared per brand rather than coded here, so the sports site has none and the
 * genre site points at the sports one. 302 and not 301 on purpose: a permanent
 * redirect is cached by browsers more or less forever, so choosing to serve the
 * category here later would still bounce every existing reader away.
 */
for (const [name, target] of Object.entries(brand.elsewhere)) {
  app.get(`/${name}`, (c) => c.redirect(target, 302));
  app.get(`/${brand.paths.category}/${name}`, (c) => c.redirect(target, 302));
}

app.get('/', async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const viewer = c.get('user');
  return cached(c, `page:home:${today}`, config.cache.scheduleTtlSeconds, async () => {
    const events = await q.scheduleForDay({ day: today, limit: 40, viewerId: viewer?.id ?? null });
    return render(<Landing user={c.get('user')} today={events} vapidKey={config.push.publicKey} />);
  });
});

app.get(`/${brand.paths.category}`, async (c) => {
  const user = c.get('user');
  // Signed out this is byte-identical and cached; signed in it carries their own
  // follow counts, and cached() already declines to store a signed-in render.
  const [counts, upcoming] = user
    ? await Promise.all([q.leagueFollowCounts(user.id), q.upcomingEventCount()])
    : [null, null];

  /*
   * Sixty seconds, down from five minutes, and the live list is the reason.
   *
   * The sports themselves change about once a season, so five minutes was free.
   * A game in progress is not: the live tick writes scores every 60s, and a
   * five-minute-old scoreboard is not stale in the harmless way a league count is
   * -- it is a page telling somebody a match is on that finished four minutes
   * ago. 60 is the freshest thing there is to serve, so serving anything older is
   * a choice with no upside.
   */
  return cached(c, 'page:sports', 60, async () => {
    const [sports, live, liveTotal, stalled, soon, soonTotal] = await Promise.all([
      q.listSports(),
      q.liveNow({ viewerId: user?.id ?? null }),
      q.liveNowCount(),
      /*
       * Fixtures that still say "in progress" but stopped being refreshed.
       *
       * Only ever used to explain an empty list. Without it "nothing is on" and
       * "we have no idea what is on" render identically, which is exactly what
       * happened when the metered proxy hit its bandwidth cap: every ESPN request
       * 402'd for sixteen hours and the page kept showing yesterday's fixtures at
       * yesterday's minute.
       */
      q.stalledLiveCount(),
      /*
       * The same 60 seconds serves both lists, and the window is the reason it can.
       *
       * A four-hour window moves by a minute in a minute, so a cached copy is at
       * worst 60 seconds' worth of the tail wrong -- it can show a fixture that has
       * just kicked off, which the live list above then also shows, and it can be a
       * minute late adding one at the far end. Neither is a page lying to somebody
       * about a game that finished, which is what set this TTL in the first place.
       */
      q.startingSoon({ hours: config.sports.soonWindowHours, viewerId: user?.id ?? null }),
      q.startingSoonCount({ hours: config.sports.soonWindowHours }),
    ]);
    return render(
      <SportsIndex
        user={user}
        sports={sports}
        leagueCounts={counts}
        upcoming={upcoming}
        live={live}
        liveTotal={liveTotal}
        stalled={stalled}
        soon={soon}
        soonTotal={soonTotal}
        soonHours={config.sports.soonWindowHours}
      />,
    );
  });
});

/**
 * Follow every league at once, and the undo beside it.
 *
 * Deliberately leagues only. A team follow was chosen one at a time and this must
 * not sweep it away -- the undo for "follow everything" is "stop following
 * everything", not "forget what I picked".
 */
app.post('/api/follow-all', async (c) => {
  const user = requireUser(c);
  const added = await q.followAllLeagues(user.id);
  return respond(c, { json: { added }, redirectTo: `${href.category()}?followed=${added}` });
});

app.post('/api/unfollow-all', async (c) => {
  const user = requireUser(c);
  const removed = await q.unfollowAllLeagues(user.id);
  return respond(c, { json: { removed }, redirectTo: `${href.category()}?unfollowed=${removed}` });
});

/**
 * Clear the whole follow list, from My games.
 *
 * Sibling of /api/unfollow-all above, and not a duplicate of it: that one is the
 * undo for the follow-everything button and spares hand-picked teams on purpose.
 * This one is pressed while looking at the list it empties, so it takes the teams
 * too -- clearing half of what is on screen is the behaviour that would surprise.
 * The counts come back so the page can say what went, rather than leaving someone
 * to work out from an empty list whether their teams were included.
 */
app.post('/api/unfollow-everything', async (c) => {
  const user = requireUser(c);
  const result = await q.unfollowAll(user.id);
  return respond(c, {
    json: result,
    redirectTo: `/following?cleared=${result.removed}&teams=${result.teams}&leagues=${result.leagues}`,
  });
});

app.get(`/${brand.paths.category}/:sport`, async (c) => {
  const user = c.get('user');
  const sport = c.req.param('sport');
  const leagues = await q.leaguesForSport(sport, user?.id ?? null);
  if (leagues.length === 0) return c.html(await render(<NotFound user={user} />), 404);

  /*
   * The same "on now" and "about to start" pair the category page carries.
   *
   * Not cached, unlike the category index: this page is cheap, and every one of
   * these lists is per-viewer (the `following` flag on each fixture). The live
   * queries are scoped in SQL rather than filtered here so the league and start
   * indexes still do the work.
   */
  const hours = config.sports.soonWindowHours;
  const [live, liveTotal, stalled, soon, soonTotal] = await Promise.all([
    q.liveNow({ viewerId: user?.id ?? null, sport }),
    q.liveNowCount({ sport }),
    q.stalledLiveCount(),
    q.startingSoon({ hours, viewerId: user?.id ?? null, sport }),
    q.startingSoonCount({ hours, sport }),
  ]);

  return c.html(
    await render(
      <SportPage
        user={user}
        sport={sport}
        leagues={leagues}
        live={live}
        liveTotal={liveTotal}
        stalled={stalled}
        soon={soon}
        soonTotal={soonTotal}
        soonHours={hours}
      />,
    ),
  );
});

app.get(`/${brand.paths.collection}/:slug`, async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const league = await q.getLeagueBySlug(slug);
  if (!league) return c.html(await render(<NotFound user={user} />), 404);

  /*
   * The cache TTL is 60 seconds, which is what makes it safe to put a live
   * scoreboard on a cached page: the same number the category index runs on, and
   * chosen there for exactly this reason -- a five-minute-old score is a page
   * telling somebody a match is on that finished four minutes ago.
   */
  const hours = config.sports.soonWindowHours;
  return cached(c, `page:league:${slug}`, config.cache.scheduleTtlSeconds, async () => {
    const [teams, events, following, live, liveTotal, stalled, soon, soonTotal] = await Promise.all(
      [
        q.teamsForLeague(league.id, user?.id ?? null),
        q.upcomingForLeague(league.id, { viewerId: user?.id ?? null }),
        q.isFollowing({ userId: user?.id, subjectType: 'league', subjectId: league.id }),
        q.liveNow({ viewerId: user?.id ?? null, leagueId: league.id }),
        q.liveNowCount({ leagueId: league.id }),
        q.stalledLiveCount(),
        q.startingSoon({ hours, viewerId: user?.id ?? null, leagueId: league.id }),
        q.startingSoonCount({ hours, leagueId: league.id }),
      ],
    );
    return render(
      <LeaguePage
        user={user}
        league={league}
        teams={teams}
        events={events}
        following={following}
        live={live}
        liveTotal={liveTotal}
        stalled={stalled}
        soon={soon}
        soonTotal={soonTotal}
        soonHours={hours}
      />,
    );
  });
});

app.get(`/${brand.paths.participant}/:slug`, async (c) => {
  const user = c.get('user');
  const team = await q.getTeamBySlug(c.req.param('slug'));
  if (!team) return c.html(await render(<NotFound user={user} />), 404);
  const hours = config.sports.soonWindowHours;
  const [events, following, live, liveTotal, stalled, soon, soonTotal] = await Promise.all([
    q.upcomingForTeam(team.id, { viewerId: user?.id ?? null }),
    q.isFollowing({ userId: user?.id, subjectType: 'team', subjectId: team.id }),
    // Either side of the fixture: "are they playing" does not care who is at home.
    q.liveNow({ viewerId: user?.id ?? null, teamId: team.id }),
    q.liveNowCount({ teamId: team.id }),
    q.stalledLiveCount(),
    q.startingSoon({ hours, viewerId: user?.id ?? null, teamId: team.id }),
    q.startingSoonCount({ hours, teamId: team.id }),
  ]);

  /*
   * The reader's own list, matched against this name.
   *
   * The sibling brand had exactly this gap and it was reported there first: a page
   * somebody reaches by searching for something to watch listed fixtures and never
   * once consulted their own line. Here the useful answer is usually the
   * competition tier -- a 24/7 club or league channel carries whatever that club
   * is doing -- so a team with nothing on today still has something to offer.
   *
   * Per-viewer, and safe only because this page is not one of the cached() ones.
   */
  const ownChannels = await ownChannelsForTeam({ userId: user?.id, team });
  // A row read, not a lookup: the team's feed is asked for by app.js. On its own
  // line like the other two pages, so it can never shift a neighbour's slot.
  const radioSession =
    user && config.radio.enabled && radio.hasTeamRadio(team.league_slug)
      ? await radio.storedSession(user.id)
      : null;

  return c.html(
    await render(
      <TeamPage
        user={user}
        team={team}
        events={events}
        following={following}
        ownChannels={ownChannels}
        radio={
          radioSession && !radioSession.unreadable
            ? { find: `/radio/find?team=${team.id}`, sides: [team.display_name] }
            : null
        }
        live={live}
        liveTotal={liveTotal}
        stalled={stalled}
        soon={soon}
        soonTotal={soonTotal}
        soonHours={hours}
      />,
    ),
  );
});

app.get('/following', async (c) => {
  const user = requireUser(c);
  const [events, follows] = await Promise.all([q.upcomingForUser(user.id), q.listFollows(user.id)]);
  // What the last clear removed, if that is how we got here. Read back off the query
  // string rather than held in a session: the redirect is the only thing carrying it,
  // and a stale flash on a reload is worse than none.
  const cleared = c.req.query('cleared')
    ? {
        removed: Number(c.req.query('cleared')) || 0,
        teams: Number(c.req.query('teams')) || 0,
        leagues: Number(c.req.query('leagues')) || 0,
      }
    : null;
  return c.html(
    await render(
      <Following
        user={user}
        events={events}
        follows={follows}
        cleared={cleared}
        vapidKey={config.push.publicKey}
        calendarUrl={`${config.siteUrl}/calendar/me/${user.calendar_token}.ics`}
      />,
    ),
  );
});

app.get('/events/:id', async (c) => {
  const user = c.get('user');
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.html(await render(<NotFound user={user} />), 404);
  const [offers, entitlement, plays, comments, followingHome, followingAway, followingLeague] =
    await Promise.all([
      q.offersForEvent(event.id),
      user ? pay.activeEntitlement({ userId: user.id, eventId: event.id }) : null,
      q.playsForEvent(event.id, { limit: 60 }),
      q.commentsForEvent(event.id),
      q.isFollowing({ userId: user?.id, subjectType: 'team', subjectId: event.home_team_id }),
      q.isFollowing({ userId: user?.id, subjectType: 'team', subjectId: event.away_team_id }),
      // A race, a tournament or a fight card has no sides to follow, so the
      // competition is the only subject there is. Without it those pages offered
      // nothing at all.
      q.isFollowing({ userId: user?.id, subjectType: 'league', subjectId: event.league_id }),
    ]);

  // Per-viewer, and safe only because this page is NOT one of the cached() ones.
  // If it is ever put behind Redis, this has to move out or one reader's channel
  // list -- credentials and all -- is served to the next visitor.
  const ownChannels = await ownChannelsForEvent({ userId: user?.id, event });
  /*
   * The per-country broadcaster listings, paired with the reader's own entries.
   *
   * ESPN and TheSportsDB say WHO carries a fixture in each country, and that was
   * text and nothing more -- a reader whose own list held the exact channel being
   * named still had to go and find it. Returns null when they have no list or
   * nothing matched, which is what makes the section render as it always did.
   */
  const [marketChannels, sharedChannels] = await Promise.all([
    marketChannelsForEvent({ userId: user?.id, markets: marketsOf(event) }),
    // Other people's open lists. Signed-in only, and it returns no URLs at all --
    // a shared channel is playable through the proxy and nowhere else, because
    // every other route hands over the address and the address is the owner's
    // provider password.
    sharedChannelsForEvent({ viewerId: user?.id ?? null, event }),
  ]);
  // Whether the "On SiriusXM" section is drawn at all: a row read, no upstream
  // call, and on its own line -- see the settings handler for why it is not in
  // the array above (it was, and shifted "Shared with you" out of existence).
  const radioSession =
    user && config.radio.enabled && radio.hasTeamRadio(event.league_slug)
      ? await radio.storedSession(user.id)
      : null;
  return c.html(
    await render(
      <EventPage
        user={user}
        event={event}
        offers={offers}
        entitlement={entitlement}
        plays={plays}
        comments={comments}
        followingHome={followingHome}
        followingAway={followingAway}
        followingLeague={followingLeague}
        ownChannels={ownChannels}
        marketChannels={marketChannels}
        sharedChannels={sharedChannels}
        streamDead={c.req.query('stream_dead') ?? null}
        radio={
          radioSession && !radioSession.unreadable
            ? {
                find: `/radio/find?event=${event.id}`,
                sides: [event.home_name, event.away_name].filter(Boolean),
              }
            : null
        }
      />,
    ),
  );
});

/**
 * The only gated part of a fixture: watching it.
 *
 * Everything else about a game -- when it starts, who is playing, where, on what
 * channel, the play log, the comments, the feeds and the whole public API -- is
 * readable without an account and stays that way. This one route is the exception,
 * because access to a stream is bought per event and belongs to one person.
 *
 * Two gates, in order, and both are required. requireUser bounces a signed-out
 * visitor to the login page carrying `next`, so they land back here afterwards
 * rather than on the home page. A signed-in visitor without an entitlement is sent
 * to the event page, which is where the offers are -- a 403 would be technically
 * right and useless, since "buy access" is the thing they actually need.
 *
 * NB: provider_ref is deliberately not rendered. The schema calls it an opaque
 * handle that a buyer never sees, and that is the whole security model for the
 * upstream slot -- putting it in the HTML would hand every viewer the credentials
 * to the provider slot the seller is reselling.
 */
app.get('/events/:id/watch', async (c) => {
  const user = requireUser(c);
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.html(await render(<NotFound user={user} />), 404);

  const entitlement = await pay.activeEntitlement({ userId: user.id, eventId: event.id });
  if (!entitlement) return c.redirect(`/events/${event.id}`, 303);

  return c.html(await render(<WatchPage user={user} event={event} entitlement={entitlement} />));
});

/* ------------------------------------------------------ profiles & people -- */

/** Sending is capped per hour. Breadth is the abuse worth stopping, not depth. */
const MESSAGE_RATE_PER_HOUR = 60;

/**
 * A public profile.
 *
 * Public on purpose: the rest of the site reads without an account and a profile
 * shows only what its owner chose to put there. `profile_public` is the opt-out,
 * and the owner still sees their own page so it never looks broken to them.
 */
/**
 * Resolve a /u/:handle page, or say why there is no page.
 *
 * Three routes hang off one handle now, and every one of them has to apply the
 * same two gates. Written out three times, the risk is not that one is wrong today
 * but that the fourth page forgets the block check -- which fails open, silently,
 * and only for the person it matters to. Returns `{ profile, isSelf }`, or `null`
 * when the caller should render NotFound.
 */
async function resolveProfile(c, viewer) {
  const profile = await q.getUserByHandle(c.req.param('handle'));
  if (!profile) return null;

  const isSelf = viewer?.id === profile.id;
  if (!profile.profile_public && !isSelf) return null;

  // A blocked viewer gets the same answer as a stranger looking for a name that
  // does not exist. Anything more specific confirms the block.
  if (viewer && !isSelf && (await q.blockExists({ a: viewer.id, b: profile.id }))) return null;

  return { profile, isSelf };
}

app.get('/u/:handle', async (c) => {
  const viewer = c.get('user');
  const found = await resolveProfile(c, viewer);
  if (!found) return c.html(await render(<NotFound user={viewer} />), 404);
  const { profile, isSelf } = found;

  const [counts, followers, following, follows, upcoming, isFollowing] = await Promise.all([
    // Same viewer as the follower list below, so the number and the list agree
    // about who is visible to this particular reader.
    q.profileCounts(profile.id, { viewerId: viewer?.id ?? null }),
    q.followersOf({ userId: profile.id, viewerId: viewer?.id ?? null, limit: 24 }),
    q.followingBy({ userId: profile.id, limit: 24 }),
    // Which teams, and when they play. The stat row has counted both since the page
    // was written and named neither, so the only thing a visitor could learn from
    // "44 teams followed" was the 44.
    q.publicFollows(profile.id, { limit: 60 }),
    q.upcomingForProfile(profile.id, { limit: 10 }),
    q.isFollowingUser({ followerId: viewer?.id, followeeId: profile.id }),
  ]);

  return c.html(
    await render(
      <ProfilePage
        user={viewer}
        profile={profile}
        counts={counts}
        followers={followers}
        following={following}
        follows={follows}
        upcoming={upcoming}
        isFollowing={isFollowing}
        isSelf={isSelf}
      />,
    ),
  );
});

/**
 * The whole follower or following list, on its own page.
 *
 * The profile shows the newest 24 of each. That is a preview, and a preview is not
 * somewhere you can answer "who follows this person" from -- so each list gets a
 * page, and the profile's heading links to it.
 *
 * One handler for both directions rather than two near-identical ones: the gates,
 * the paging and the markup are the same, and only which query runs differs. The
 * difference that matters is that followers are filtered for the viewer's blocks
 * and following is not, which is the same asymmetry profileCounts has.
 */
const PEOPLE_PAGE_SIZE = 50;

for (const kind of ['followers', 'following']) {
  app.get(`/u/:handle/${kind}`, async (c) => {
    const viewer = c.get('user');
    const found = await resolveProfile(c, viewer);
    if (!found) return c.html(await render(<NotFound user={viewer} />), 404);
    const { profile } = found;

    // ?page= is 1-based for a reader and 0-based here. Anything unparseable is
    // page one rather than an error: a mangled query string should not be a wall.
    const page = Math.max((Number.parseInt(c.req.query('page'), 10) || 1) - 1, 0);
    const viewerId = viewer?.id ?? null;

    const [counts, people] = await Promise.all([
      q.profileCounts(profile.id, { viewerId }),
      kind === 'followers'
        ? q.followersOf({
            userId: profile.id,
            viewerId,
            limit: PEOPLE_PAGE_SIZE,
            offset: page * PEOPLE_PAGE_SIZE,
          })
        : q.followingBy({
            userId: profile.id,
            limit: PEOPLE_PAGE_SIZE,
            offset: page * PEOPLE_PAGE_SIZE,
          }),
    ]);

    return c.html(
      await render(
        <PeopleListPage
          user={viewer}
          profile={profile}
          kind={kind}
          people={people}
          total={kind === 'followers' ? counts.followers : counts.following}
          page={page}
          pageSize={PEOPLE_PAGE_SIZE}
        />,
      ),
    );
  });
}

for (const [path, fn] of [
  ['/api/users/follow', q.followUser],
  ['/api/users/unfollow', q.unfollowUser],
]) {
  app.post(path, async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody();
    const target = await q.getUserByHandle(String(body.handle ?? ''));
    if (!target) return c.json({ error: 'no such person' }, 404);
    if (await q.blockExists({ a: user.id, b: target.id })) {
      return c.json({ error: 'unavailable' }, 403);
    }
    await fn({ followerId: user.id, followeeId: target.id });
    return respond(c, { json: { ok: true }, redirectTo: `/u/${target.handle}` });
  });
}

for (const [path, fn] of [
  ['/api/users/block', q.blockUser],
  ['/api/users/unblock', q.unblockUser],
]) {
  app.post(path, async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody();
    const target = await q.getUserByHandle(String(body.handle ?? ''));
    if (!target) return c.json({ error: 'no such person' }, 404);
    await fn({ blockerId: user.id, blockedId: target.id });
    return respond(c, { json: { ok: true }, redirectTo: '/messages' });
  });
}

app.post('/api/profile', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const handle = String(body.handle ?? '').trim();

  if (handle && !q.handleAvailableShape(handle)) {
    return respond(c, {
      json: { error: 'bad handle' },
      status: 400,
      redirectTo:
        '/settings?profile_error=' +
        encodeURIComponent(
          'A handle is 3–30 letters, numbers or underscores, and cannot be a reserved word.',
        ),
    });
  }

  const result = await q.updateProfile({
    userId: user.id,
    handle: handle || null,
    displayName: String(body.display_name ?? '').trim() || null,
    bio:
      String(body.bio ?? '')
        .trim()
        .slice(0, 500) || null,
    profilePublic: body.profile_public === 'on' || body.profile_public === 'true',
  });

  if (!result.ok) {
    return respond(c, {
      json: { error: result.error },
      status: 409,
      redirectTo: `/settings?profile_error=${encodeURIComponent(result.error)}`,
    });
  }
  return respond(c, { json: result.user, redirectTo: '/settings?profile=saved' });
});

/* --------------------------------------------------------------- messages -- */

app.get('/messages', async (c) => {
  const user = requireUser(c);
  const threads = await q.conversations({ userId: user.id });
  return c.html(await render(<Inbox user={user} threads={threads} />));
});

app.get('/messages/:handle', async (c) => {
  const user = requireUser(c);
  const other = await q.getUserByHandle(c.req.param('handle'));
  if (!other) return c.html(await render(<NotFound user={user} />), 404);
  if (other.id === user.id) return c.redirect('/messages', 303);

  const blocked = await q.blockExists({ a: user.id, b: other.id });

  /*
   * Full history is what the membership sells, so a non-member gets a window.
   *
   * Nothing is deleted to make that true and the withheld count is fetched
   * separately, because "there is nothing older" and "there are 340 older messages
   * you cannot open" must not render as the same empty space. A page that cannot
   * tell them apart reads as data loss, which is a worse thing to sell against.
   */
  const member = await isMember(user);
  const sinceDays = historyWindowDays(member);
  const [messages, olderCount] = blocked
    ? [[], 0]
    : await Promise.all([
        q.thread({ userId: user.id, otherId: other.id, sinceDays }),
        q.olderMessageCount({ userId: user.id, otherId: other.id, sinceDays }),
      ]);

  return c.html(
    await render(
      <Thread
        user={user}
        other={other}
        messages={messages}
        blocked={blocked}
        member={member}
        historyDays={sinceDays}
        olderCount={olderCount}
      />,
    ),
  );
});

app.post('/api/messages', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const other = await q.getUserByHandle(String(body.handle ?? ''));
  const text = String(body.body ?? '').trim();

  if (!other || other.id === user.id) return c.json({ error: 'no such person' }, 404);
  if (!text) return c.redirect(`/messages/${other.handle}`, 303);
  if (text.length > 4000) return c.json({ error: 'too long' }, 400);

  // A block is checked in both directions, so neither party can reopen a
  // conversation the other closed.
  if (await q.blockExists({ a: user.id, b: other.id })) {
    return c.json({ error: 'unavailable' }, 403);
  }

  const sent = await q.messagesSentSince({ senderId: user.id, minutes: 60 });
  if (sent >= MESSAGE_RATE_PER_HOUR) {
    return respond(c, {
      json: { error: 'rate limited' },
      status: 429,
      redirectTo: `/messages/${other.handle}?slow=1`,
    });
  }

  await q.sendMessage({ senderId: user.id, recipientId: other.id, body: text });
  return respond(c, { json: { ok: true }, redirectTo: `/messages/${other.handle}` });
});

/* --------------------------------------------------------- own playlists -- */

/**
 * A reader's own channel list.
 *
 * Every route here is behind requireUser and scoped to that user's rows. The list
 * is theirs: it is never pooled, never shown to another account, and never joined
 * to stream_offers -- this is a personal player feature, not a distribution one.
 */
/**
 * Where an import lands.
 *
 * `channels` is null when the provider's file hashed the same as last time, which
 * is the common case for a save that only changed the name. Passing that straight
 * into the notice produced "Imported NaN channels", so the two outcomes are named
 * separately here rather than counted.
 */
function playlistNoticeFor(result) {
  if (result?.renamed) return '/settings?playlist=renamed';
  if (result?.unchanged || result?.channels == null) return '/settings?playlist=unchanged';
  return `/settings?playlist=${result.channels}`;
}

/**
 * Add a list, or edit the one already stored.
 *
 * One route for both, because from the reader's side it is one form. Leaving the
 * address blank when a list exists means "keep it" -- that is what makes renaming
 * possible without re-typing a URL that has a password in it, which was the only
 * way to change anything here before.
 *
 * Re-submitting the SAME address is a save, not a re-import: the stored content
 * hash goes with it, so an unchanged provider file leaves all 7,000 channel rows
 * (and their probe verdicts) alone instead of deleting and reinserting them.
 */
app.post('/api/playlist', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const url = String(body.url ?? '').trim();
  const label = String(body.label ?? '').trim();

  try {
    const existing = await q.getPlaylist(user.id);

    if (!url) {
      if (!existing) throw new Error('Add the address of your playlist.');
      const row = await q.renamePlaylist({ userId: user.id, label: label || existing.label });
      return respond(c, {
        json: { renamed: true, label: row?.label ?? null },
        redirectTo: playlistNoticeFor({ renamed: true }),
      });
    }

    const same = existing ? auth.open(existing.source_url) === url : false;
    const result = await importPlaylist({
      userId: user.id,
      url,
      label,
      knownHash: same ? (existing.content_hash ?? null) : null,
    });
    return respond(c, { json: result, redirectTo: playlistNoticeFor(result) });
  } catch (err) {
    return respond(c, {
      json: { error: err.message },
      status: 400,
      redirectTo: `/settings?playlist_error=${encodeURIComponent(err.message)}`,
    });
  }
});

/**
 * Hand the stored address back to the account that stored it.
 *
 * `no-store` and JSON-only, because the body is a credential: it must not be
 * written into the cached settings page, and it must not sit in a back-forward
 * cache. Reaching it takes a session, and it answers with that session's own row
 * -- there is no id in the request to point somewhere else.
 */
app.get('/api/playlist/source', async (c) => {
  const user = requireUser(c);
  const source = await playlistSource(user.id);
  if (!source) return c.json({ error: 'You have not added a list.' }, 404);
  c.header('cache-control', 'no-store');
  if (!source.url) {
    return c.json({ error: 'That stored address could not be read. Please add it again.' }, 409);
  }
  return c.json(source);
});

app.post('/api/playlist/refresh', async (c) => {
  const user = requireUser(c);
  try {
    const result = await refreshPlaylist(user.id);
    return respond(c, { json: result, redirectTo: playlistNoticeFor(result) });
  } catch (err) {
    return respond(c, {
      json: { error: err.message },
      status: 400,
      redirectTo: `/settings?playlist_error=${encodeURIComponent(err.message)}`,
    });
  }
});

/**
 * Open this account's list to everybody signed in, or close it again.
 *
 * Owner-only, and the query is keyed on the session's own user id rather than on
 * anything the request supplies, so there is no id to tamper with.
 *
 * What the owner is agreeing to is stated on the form rather than here, because a
 * consent nobody reads is not one: their provider line permits a small number of
 * simultaneous connections, and other people watching it use them.
 */
app.post('/api/playlist/share', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const label = String(body.label ?? '').trim();

  /*
   * Still accepts the old `shared=1`, which is what an unreloaded page sends.
   *
   * That form is in browsers right now and its meaning has not changed -- it was
   * always "open to everybody signed in". Reading it as anything narrower would
   * quietly close lists their owners believe are open; reading a missing audience
   * as anything WIDER would be the far worse mistake, so the fallback for an
   * unrecognised value is 'none' and the query enforces that too.
   */
  const audience = body.audience
    ? String(body.audience)
    : String(body.shared ?? '') === '1'
      ? 'everyone'
      : 'none';

  /*
   * Sharing with named friends is what the membership sells; sharing with the
   * whole site is not, and never was. A lapsed member keeps 'everyone' and is
   * refused only the narrower option -- the gate must never be able to widen who
   * can reach somebody's provider credentials.
   */
  if (audience === 'friends' && !(await isMember(user))) {
    return respond(c, {
      json: { error: 'premium only' },
      status: 402,
      redirectTo: '/premium?want=friends',
    });
  }

  const row = await q.setPlaylistSharing({ userId: user.id, audience, label: label || null });
  if (!row) {
    return respond(c, {
      json: { error: 'no list to share' },
      status: 400,
      redirectTo: '/settings?playlist_error=There%20is%20no%20list%20on%20this%20account%20yet.',
    });
  }
  return respond(c, { json: row, redirectTo: `/settings?shared=${row.share_audience}` });
});

/**
 * Name one person who may see this list, or take them off it again.
 *
 * Removal is deliberately NOT gated on membership. A lapsed member must always be
 * able to close their line down -- gating the revoke would leave somebody unable to
 * withdraw a credential they had shared, which is the one direction this must
 * never fail in.
 */
app.post('/api/playlist/share/grant', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  const audienceUserId = String(body.user_id ?? '');
  const allowed = String(body.allowed ?? '') === '1';

  if (allowed && !(await isMember(user))) {
    return respond(c, {
      json: { error: 'premium only' },
      status: 402,
      redirectTo: '/premium?want=friends',
    });
  }

  const ok = await q.setPlaylistShareGrant({ userId: user.id, audienceUserId, allowed });
  return respond(c, { json: { ok }, redirectTo: '/settings#sharing' });
});

/**
 * Whose lists are open, and how big they are.
 *
 * Signed-in only. Not because the fact is sensitive -- the owners chose to
 * publish it -- but because there is nothing here for somebody who cannot play
 * any of it, and a page listing other people's subscriptions to the open web is
 * an invitation to scrape.
 *
 * Never a URL, never a channel title. This says who is sharing and how much;
 * what is in a list is answered on an event page, against an event, one entry at
 * a time.
 */
app.get('/shared', async (c) => {
  const user = requireUser(c);
  const owners = await q.sharedPlaylistOwners({ viewerId: user.id });
  return c.html(await render(<SharedLists user={user} owners={owners} />));
});

/**
 * Play an entry from somebody else's shared list.
 *
 * Separate from /events/:id/stream.ts rather than a flag on it, and the split is
 * the point: that route resolves a channel by INDEX within the reader's own
 * ranked lists, which only makes sense for a list the reader owns. This one
 * resolves by channel id, and `sharedChannelById` is what authorises it -- the
 * row comes back only while its owner's list is shared.
 *
 * Three things differ from the private path, all of them because the line belongs
 * to somebody else:
 *
 *   1. The slot is claimed against the OWNER. Twenty readers on one subscription
 *      is how that subscription gets terminated, so the ceiling has to be a
 *      property of the line rather than of the audience.
 *   2. A busy line REFUSES rather than evicting. On the owner's own stream,
 *      eviction is right -- pressing Play elsewhere says which channel they want
 *      now. Taking a stranger's film off them because you clicked something is
 *      not the same act, and the honest answer is that the line is in use.
 *   3. There is no .m3u and no VLC link anywhere near this. Those hand over the
 *      URL, and the URL is the owner's provider password.
 */
app.get('/shared/:channelId/stream.ts', async (c) => {
  const user = requireUser(c);
  if (!config.playlists.proxy.enabled) return c.json({ error: 'player is off' }, 404);

  const row = await q.sharedChannelById(Number(c.req.param('channelId')), {
    viewerId: user.id,
  });
  if (!row) return c.json({ error: 'not shared' }, 404);

  /*
   * The owner's own session is not subject to the refusal below.
   *
   * They can always take their own line back -- it is theirs, and a reader who
   * has opened their list to others must not be locked out of it by them.
   */
  const isOwner = row.owner_id === user.id;
  if (!isOwner && streamSlotsOpen(row.owner_id) >= config.playlists.proxy.maxPerUser) {
    return c.json({ error: 'that line is in use right now' }, 409);
  }

  const stop = new AbortController();
  const signal = stop.signal;
  if (c.req.raw.signal?.aborted) stop.abort();
  else c.req.raw.signal?.addEventListener('abort', () => stop.abort(), { once: true });

  // Against the owner, not the viewer. See point 1 above.
  const release = claimStreamSlot(row.owner_id, {
    max: config.playlists.proxy.maxPerUser,
    evict: () => stop.abort(),
  });
  if (!release) return c.json({ error: 'player is off' }, 404);

  let result;
  try {
    result = await openStream(auth.open(row.stream_url), { signal });
  } catch (err) {
    release();
    throw err;
  }

  if (!result.ok) {
    release();
    // Written back against the owner's row, because it is a fact about the slot
    // rather than about who asked. Not for a reader who simply closed the tab.
    if (!result.silent) {
      await q
        .markSharedChannelChecked({
          channelId: row.id,
          live: verdictToStore(result),
          note: result.note,
        })
        .catch(() => {});
    }
    return c.json({ error: result.note }, result.status === 499 ? 499 : result.status);
  }

  await q
    .markSharedChannelChecked({ channelId: row.id, live: true, note: result.note })
    .catch(() => {});

  signal.addEventListener('abort', release, { once: true });
  const body = result.body.pipeThrough(new TransformStream({ flush: release, cancel: release }));

  return new Response(body, {
    headers: {
      'content-type': /^video\/|^audio\//i.test(result.contentType)
        ? result.contentType
        : 'video/mp2t',
      'cache-control': 'no-store, private',
      'accept-ranges': 'none',
      'x-accel-buffering': 'no',
    },
  });
});

/** Is one shared entry actually there? Same shape as the private check. */
app.get('/shared/:channelId/check', async (c) => {
  const user = requireUser(c);
  const row = await q.sharedChannelById(Number(c.req.param('channelId')), {
    viewerId: user.id,
  });
  if (!row) return c.json({ error: 'not shared' }, 404);

  // A probe is a connection like any other, and it is the owner's line it would
  // be opened on. Never while that line is carrying something.
  if (streamSlotsOpen(row.owner_id) > 0) return c.json({ skipped: 'watching' });

  const result = await probeStream(auth.open(row.stream_url), { signal: c.req.raw.signal });
  await q
    .markSharedChannelChecked({
      channelId: row.id,
      live: verdictToStore(result),
      note: result.note,
    })
    .catch(() => {});
  return c.json(result);
});

app.post('/api/playlist/delete', async (c) => {
  const user = requireUser(c);
  await q.deletePlaylist(user.id);
  return respond(c, { json: { deleted: true }, redirectTo: '/settings' });
});

/**
 * Hand one channel back to the person who supplied it.
 *
 * This is the entire playback story, and its smallness is the point: the reader's
 * own URL, returned to the reader's own browser, as a file their own player opens.
 * Nothing is proxied, so tipoffwatch is never in the path of the stream itself --
 * which also sidesteps the two walls a browser puts up, since an http:// source is
 * blocked as mixed content and a self-signed upstream certificate is rejected
 * outright. A desktop player has neither restriction.
 *
 * `no-store`, because the response body is a credential.
 */
/**
 * Which channel a link on the event page is pointing at.
 *
 * `series` picks from the competition tier, `n` from the fixture matches. Two
 * parameters rather than one index across a concatenated list, so adding a match
 * cannot silently shift which channel an existing link points at.
 *
 * Shared by the .m3u download and the in-page player so the two can never
 * disagree about what "channel 2" means -- and, more to the point, so both go
 * through ownChannelsForEvent, which is where ownership is enforced. An index is
 * not a capability: it selects from a list that was already scoped to this
 * account by the query that built it.
 */
async function pickOwnChannel(c, user, event) {
  const { matches, competition } = await ownChannelsForEvent({ userId: user.id, event });
  const seriesIdx = c.req.query('series');
  const list = seriesIdx === undefined ? matches : competition;
  const wanted = Number(seriesIdx ?? c.req.query('n') ?? 0);
  if (list.length === 0) return { list: [], asked: 0 };
  return { list, asked: Number.isInteger(wanted) && list[wanted] ? wanted : 0 };
}

app.get('/events/:id/playlist.m3u', async (c) => {
  const user = requireUser(c);
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.notFound();

  const { list, asked } = await pickOwnChannel(c, user, event);
  if (list.length === 0) return c.redirect(`/events/${event.id}`, 303);

  /*
   * Ask the stream whether it is there, before handing anybody a file.
   *
   * A provider list is mostly aspirational: the slot exists, the title is right,
   * and a large share of them answer with an HTML error page rather than video.
   * Handing one of those over is worse than handing over nothing, because the
   * reader finds out by tapping it in the middle of a match.
   *
   * The one they asked for is tried first, then the rest in rank order. Probing
   * is sequential inside firstLiveChannel because these are one subscriber's own
   * connections and the line caps how many can be open at once.
   */
  const ordered = [list[asked], ...list.filter((_, i) => i !== asked)].filter(Boolean);
  const { pick, tried } = await firstLiveChannel(ordered, {
    onResult: async (ch, result) => {
      if (!ch.id) return;
      // Remembered so the page can stop offering a dead slot to the next reader,
      // and so the next tap does not re-probe what we just learned.
      await q
        .markChannelChecked({
          userId: user.id,
          channelId: ch.id,
          // NULL, not false, when the probe proved nothing. A timeout on the
          // right channel used to hide it from the candidate query for thirty
          // minutes, which is how the reader ended up offered the next-best
          // thing instead -- or nothing at all.
          live: verdictToStore(result),
          note: result.note,
        })
        .catch(() => {});
    },
  });

  if (!pick) {
    const why = tried[0]?.note ?? 'no answer';
    return c.redirect(`/events/${event.id}?stream_dead=${encodeURIComponent(why)}`, 303);
  }

  c.header('content-type', 'audio/x-mpegurl; charset=utf-8');
  c.header('content-disposition', `attachment; filename="${event.short_name ?? 'game'}.m3u"`);
  c.header('cache-control', 'no-store, private');
  return c.body(oneChannelM3u(pick));
});

/**
 * The same channel, for a device with no player to hand it to.
 *
 * A television is the case this exists for. A Fire TV, an Android TV box or a
 * games console has a browser and nothing else: no VLC to deep-link into, no
 * Infuse, no filesystem to drop an .m3u onto. "Open it in another app" is not an
 * answer there, and a sports app is watched on exactly that screen.
 *
 * So the bytes come through this server -- the only route on the site that does
 * that, and see packages/playlists/src/proxy.js for why a browser leaves no other
 * option. What it is NOT is a restream: the response is one reader's own
 * subscription played back to that reader's own session, never cached, never
 * shared, and never reachable without the cookie of the account that supplied the
 * list.
 *
 * `.ts` in the path rather than a query flag, because what comes back really is a
 * transport stream and some clients decide how to treat a URL by looking at it.
 */
/**
 * Is this one channel actually streaming, right now?
 *
 * The page used to list every channel whose title matched the fixture and let the
 * reader find out by pressing Play. A provider list is mostly aspirational --
 * the slot exists, the title is right, and a large share answer with an HTML
 * error page rather than video -- so "Your provider did not send a stream for
 * that channel" was a routine outcome of using the feature as intended. The .m3u
 * route has probed since it was written; the page had no way to.
 *
 * One channel per request, and the client walks the list in order. Not a single
 * endpoint that checks them all: these are one subscriber's own connections on a
 * line that caps them, the answers arrive one at a time anyway, and a row that
 * has been cleared should become usable then rather than when the slowest of
 * five has timed out.
 *
 * The verdict is written back, so the next reader of this page -- and the .m3u
 * route, and the 30-minute filter in playlistChannels -- all inherit what this
 * one learned.
 */
app.get('/events/:id/channel-check', async (c) => {
  const user = requireUser(c);

  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.notFound();

  /*
   * Never while something is playing.
   *
   * A probe is a second connection, and on a line that permits one it is the
   * connection that gets the subscription suspended -- or, now that a new claim
   * evicts the old, it would be the reader's own match being taken off them by a
   * background check. The page skips the sweep when it is playing something; this
   * is the half that does not depend on the page behaving.
   */
  if (streamSlotsOpen(user.id) > 0) return c.json({ skipped: 'watching' });

  const { list, asked } = await pickOwnChannel(c, user, event);
  const pick = list[asked];
  if (!pick) return c.json({ error: 'no channel' }, 404);

  const result = await probeStream(pick.url, { signal: c.req.raw.signal });

  if (pick.id) {
    await q
      .markChannelChecked({
        userId: user.id,
        channelId: pick.id,
        live: verdictToStore(result),
        note: result.note,
      })
      .catch(() => {});
  }

  return c.json(result);
});

app.get('/events/:id/stream.ts', async (c) => {
  const user = requireUser(c);
  if (!config.playlists.proxy.enabled) return c.json({ error: 'player is off' }, 404);

  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.notFound();

  const { list, asked } = await pickOwnChannel(c, user, event);
  const pick = list[asked];
  if (!pick) return c.json({ error: 'no channel' }, 404);

  /*
   * Two ways this stream can be told to stop, and it has to obey both.
   *
   * The reader leaving is `c.req.raw.signal`. The other is this account starting
   * a different channel -- pressing Play elsewhere means they want the other one
   * now, so the older stream is evicted rather than the new one being refused.
   * Both end up on one controller, because everything downstream takes a single
   * signal and neither reason to stop is more real than the other.
   */
  const stop = new AbortController();
  const signal = stop.signal;
  const abortOnLeave = () => stop.abort();
  if (c.req.raw.signal?.aborted) stop.abort();
  else c.req.raw.signal?.addEventListener('abort', abortOnLeave, { once: true });

  /*
   * Claimed before the upstream is touched, not after.
   *
   * A reader with two connections open on a line that allows one is how a
   * subscription gets suspended, so the slot is taken first and the previous
   * stream is aborted here -- before the replacement connects, not alongside it.
   */
  const release = claimStreamSlot(user.id, {
    max: config.playlists.proxy.maxPerUser,
    evict: () => stop.abort(),
  });
  if (!release) return c.json({ error: 'player is off' }, 404);

  let result;
  try {
    result = await openStream(pick.url, { signal });
  } catch (err) {
    // openStream answers rather than throws for everything it anticipates, so
    // this is the unanticipated one -- and a slot that leaks here is the reader's
    // only connection, held by nothing, until the container restarts.
    release();
    throw err;
  }

  if (!result.ok) {
    release();
    /*
     * Remembered, so the page stops offering a slot that is not there -- and
     * through `verdictToStore`, which is the same rule the probe writes by and
     * the reason it exists: only a DEFINITIVE no is a fact about the channel.
     *
     * This used to write `false` for every failure, which is how a busy line took
     * the right game off the page. A stored no hides the row from the candidate
     * query for thirty minutes, so a provider that was merely occupied for two
     * seconds during a reconnect cost the reader the channel for the rest of the
     * first half. A transient failure now stores NULL -- unknown, and offerable,
     * because that is what it is. Not for a reader who simply closed the tab
     * either: that says nothing about the channel at all.
     */
    if (!result.silent && pick.id) {
      await q
        .markChannelChecked({
          userId: user.id,
          channelId: pick.id,
          live: verdictToStore(result),
          note: result.note,
        })
        .catch(() => {});
    }
    return c.json({ error: result.note }, result.status === 499 ? 499 : result.status);
  }

  if (pick.id) {
    await q
      .markChannelChecked({ userId: user.id, channelId: pick.id, live: true, note: result.note })
      .catch(() => {});
  }

  /*
   * Give the slot back when the stream ends, however it ends.
   *
   * Two ways out and both are wired, because missing either leaks the reader's
   * only connection until the process restarts: `flush` is the upstream reaching
   * its end, and the abort is the reader closing the tab -- which is by far the
   * commoner one and never touches the transform at all. Releasing twice is
   * harmless by construction; releasing never is a feature that works once per
   * deploy.
   */
  signal.addEventListener('abort', release, { once: true });
  const body = result.body.pipeThrough(
    new TransformStream({
      flush: release,
      cancel: release,
    }),
  );

  return new Response(body, {
    headers: {
      // What the provider called it, unless it declined to say. mpegts.js reads
      // the bytes rather than the header, but a bare octet-stream tells an
      // intermediary nothing about whether it may buffer.
      'content-type': /^video\/|^audio\//i.test(result.contentType)
        ? result.contentType
        : 'video/mp2t',
      // The body is somebody's live subscription. Nothing may hold a copy.
      'cache-control': 'no-store, private',
      // No length, no ranges: this has no end and cannot be seeked. Saying so
      // stops a client asking for byte ranges the provider will not honour.
      'accept-ranges': 'none',
      // Ask intermediaries to pass it through rather than accumulate it; a proxy
      // that buffers a live stream adds its buffer to the latency, permanently.
      'x-accel-buffering': 'no',
    },
  });
});

/**
 * A reader's own channel list, browsed by the provider's own groups.
 *
 * Ported from the sibling brand along with group_title itself. Per-account by
 * construction: every query is scoped to the signed-in user's rows, nothing is
 * pooled and nothing is relayed. What a provider calls "Sports | US" stays exactly
 * that rather than being mapped onto our leagues -- a confident wrong mapping is
 * worse than the raw string the reader already sees in their own player.
 *
 * The kind breakdown is the point of the page as much as the groups are: "does my
 * provider actually carry films" had no answer anywhere on the site, so a line of
 * live channels and a broken matcher looked identical from the outside.
 */
app.get('/my/channels', async (c) => {
  const user = requireUser(c);
  const [playlist, groups, kinds] = await Promise.all([
    q.getPlaylist(user.id),
    q.playlistGroups(user.id),
    q.playlistKindCounts(user.id),
  ]);
  return c.html(
    await render(<Channels user={user} playlist={playlist} groups={groups} kinds={kinds} />),
  );
});

/* ------------------------------------------------- one channel, by its id -- */

/**
 * The reader's own channel, addressed by row id rather than by list position.
 *
 * The three routes above resolve a channel by INDEX into a ranked list, which is
 * the right handle when the page IS that ranked list. The broadcaster listings
 * are a different arrangement of the same channels -- by country, in the order
 * the provider gave them -- so an index there means nothing, and these exist so
 * that arrangement can offer the same three controls.
 *
 * Ownership is enforced by the query rather than by these handlers remembering
 * to: ownChannelById joins through user_playlists on the session's user id, so an
 * id from anywhere else comes back empty.
 */
async function ownChannelOr404(c, user) {
  const row = await q.ownChannelById(user.id, Number(c.req.param('channelId')));
  if (!row) return null;
  const url = auth.open(row.stream_url);
  return url ? { ...row, url } : null;
}

app.get('/my/channels/:channelId/check', async (c) => {
  const user = requireUser(c);
  // A probe is a connection, and the line permits one. Never while it is carrying
  // something -- see the note on /events/:id/channel-check.
  if (streamSlotsOpen(user.id) > 0) return c.json({ skipped: 'watching' });

  const ch = await ownChannelOr404(c, user);
  if (!ch) return c.json({ error: 'no channel' }, 404);

  const result = await probeStream(ch.url, { signal: c.req.raw.signal });
  await q
    .markChannelChecked({
      userId: user.id,
      channelId: ch.id,
      live: verdictToStore(result),
      note: result.note,
    })
    .catch(() => {});
  return c.json(result);
});

app.get('/my/channels/:channelId/playlist.m3u', async (c) => {
  const user = requireUser(c);
  const ch = await ownChannelOr404(c, user);
  if (!ch) return c.notFound();

  c.header('content-type', 'audio/x-mpegurl; charset=utf-8');
  c.header(
    'content-disposition',
    `attachment; filename="${(ch.title || 'channel').slice(0, 60)}.m3u"`,
  );
  // The body is a credential.
  c.header('cache-control', 'no-store, private');
  return c.body(oneChannelM3u(ch));
});

app.get('/my/channels/:channelId/stream.ts', async (c) => {
  const user = requireUser(c);
  if (!config.playlists.proxy.enabled) return c.json({ error: 'player is off' }, 404);

  const ch = await ownChannelOr404(c, user);
  if (!ch) return c.json({ error: 'no channel' }, 404);

  const stop = new AbortController();
  const signal = stop.signal;
  if (c.req.raw.signal?.aborted) stop.abort();
  else c.req.raw.signal?.addEventListener('abort', () => stop.abort(), { once: true });

  const release = claimStreamSlot(user.id, {
    max: config.playlists.proxy.maxPerUser,
    evict: () => stop.abort(),
  });
  if (!release) return c.json({ error: 'player is off' }, 404);

  let result;
  try {
    result = await openStream(ch.url, { signal });
  } catch (err) {
    release();
    throw err;
  }

  if (!result.ok) {
    release();
    if (!result.silent) {
      await q
        .markChannelChecked({
          userId: user.id,
          channelId: ch.id,
          live: verdictToStore(result),
          note: result.note,
        })
        .catch(() => {});
    }
    return c.json({ error: result.note }, result.status === 499 ? 499 : result.status);
  }

  await q
    .markChannelChecked({ userId: user.id, channelId: ch.id, live: true, note: result.note })
    .catch(() => {});

  signal.addEventListener('abort', release, { once: true });
  const body = result.body.pipeThrough(new TransformStream({ flush: release, cancel: release }));

  return new Response(body, {
    headers: {
      'content-type': /^video\/|^audio\//i.test(result.contentType)
        ? result.contentType
        : 'video/mp2t',
      'cache-control': 'no-store, private',
      'accept-ranges': 'none',
      'x-accel-buffering': 'no',
    },
  });
});

/* -------------------------------------------------------------------- auth -- */

/**
 * How long to wait, in words somebody can act on.
 *
 * "Retry in 3600 seconds" is a number a person has to do arithmetic on while
 * already annoyed.
 */
function waitFor(seconds) {
  if (seconds < 90) return `${Math.max(seconds, 1)} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/**
 * Escalating backoff in front of one auth route. See `lib/auth-throttle.js`.
 *
 * Each route gets its OWN bucket, which is the whole reason `bucket` is a
 * parameter rather than derived from the path once. The throttled password form
 * tells people to use a sign-in link instead, so the sign-in link must still be
 * reachable when it does — sharing one counter across both would make that
 * advice a lie, and lock somebody out of the account they were trying to reach.
 *
 * A caller with no forwarded address is let through untracked rather than
 * bucketed under a placeholder: behind Railway there is always one, so this only
 * fires for something reaching the app directly, and lumping those together
 * would let the first eight of them lock out the rest.
 */
function authBackoff(bucket, refuse, limits = undefined) {
  return async (c, next) => {
    const caller = callerAddress(c);
    if (!caller) return next();

    const verdict = attempt(`${bucket}:${caller}`, Date.now(), limits);
    if (verdict.ok) return next();

    console.warn(
      `[auth] ${bucket} backoff: ${caller} strike ${verdict.strikes}, ${verdict.retryAfter}s`,
    );
    c.header('retry-after', String(verdict.retryAfter));
    // Nothing here is worth a cache entry, and a 429 that got cached would
    // outlive the lock it was reporting.
    c.header('cache-control', 'no-store');
    return refuse(c, verdict.retryAfter);
  };
}

/*
 * The sign-in PAGE, not the forms on it.
 *
 * A crawler that ignores robots.txt and is not caught by the user-agent block
 * above still gets metered here. It is the same doubling curve as the forms, on
 * the far gentler VIEW allowance -- thirty views before any penalty and an hour
 * at worst -- because unlike the forms this is a page a real person looks at,
 * and the cost of being wrong is somebody who cannot reach sign-in at all.
 */
const viewBackoff = authBackoff(
  'view',
  (c, retryAfter) => c.text(`Too many requests. Try again in ${waitFor(retryAfter)}.`, 429),
  VIEW,
);

app.get('/login', viewBackoff);
app.get('/login', async (c) =>
  c.html(await render(<SignIn mode="login" next={c.req.query('next')} />)),
);
app.get('/signup', viewBackoff);
app.get('/signup', async (c) =>
  c.html(await render(<SignIn mode="signup" next={c.req.query('next')} />)),
);

/**
 * Request a sign-in link.
 *
 * The answer is identical whether or not the address has an account, and a send
 * failure is reported as success too. Any difference here turns this endpoint into
 * a way to ask "is this person a user?".
 */
app.post(
  '/api/auth/magic',
  authBackoff('magic', async (c, retryAfter) =>
    c.req.header('accept')?.includes('application/json')
      ? c.json({ error: `Too many requests. Try again in ${waitFor(retryAfter)}.` }, 429)
      : c.html(
          await render(
            <SignIn
              mode="login"
              magicError={`Too many sign-in links requested from here. Try again in ${waitFor(retryAfter)}.`}
            />,
          ),
          429,
        ),
  ),
);
app.post('/api/auth/magic', async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? '')
    .trim()
    .toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    try {
      const url = await auth.createLoginLink(email);
      await sendLoginLink({ email, url });
    } catch (err) {
      console.error('[auth] link send failed:', err.message);
    }
  }
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('application/json')) return c.json({ ok: true });
  return c.html(await render(<SignIn mode="login" sent />));
});

/*
 * Presenting a token is metered too. Guessing one is 2^256 work so this is not
 * about the token, but it is the closest thing here to a failed login and it is
 * a database round trip a stranger can ask for as often as it likes.
 */
app.get(
  '/auth/magic',
  authBackoff('token', (c, retryAfter) =>
    c.text(`Too many attempts. Try again in ${waitFor(retryAfter)}.`, 429),
  ),
);
app.get('/auth/magic', async (c) => {
  const token = c.req.query('t');
  if (!token) return c.redirect('/login', 303);
  const result = await auth.consumeLoginLink(token, { userAgent: c.req.header('user-agent') });
  if (!result) return c.html(await render(<SignIn mode="login" next="/following" />), 400);

  /*
   * The invite is credited HERE, and only for an account that did not exist a
   * moment ago.
   *
   * This is the one point in the system that knows both things at once: which code
   * was clicked (the cookie) and whether this sign-in created the account
   * (`created`, straight from the upsert). A commission is paid against that row,
   * so getting it from anywhere else -- a timestamp, a guess -- would mean paying
   * somebody for a sign-in.
   *
   * It never throws: an invite that cannot be credited must not cost somebody
   * their sign-in.
   */
  // A link that worked is proof of a mailbox, which is the whole security model
  // here — so the fumbled ones before it were not an attack.
  const caller = callerAddress(c);
  if (caller) forgive(`token:${caller}`);

  const code = getCookie(c, invites.INVITE_COOKIE);
  if (code) await invites.claimInvite({ code, user: result.user, created: result.created });

  /*
   * The session header goes on FIRST, and clearing the invite cookie after it.
   *
   * `c.header` REPLACES every set-cookie already on the response; hono's setCookie
   * appends. Done the other way round, the session cookie silently deletes the
   * clear -- and the code stays in the browser, to be retried on every later
   * sign-in.
   */
  c.header('set-cookie', auth.sessionCookie(result.sessionId));
  // Spent either way. A code that survives is one that gets tried again by an
  // account it can never credit.
  if (code) setCookie(c, invites.INVITE_COOKIE, '', { path: '/', maxAge: 0 });

  return c.redirect(c.req.query('next') ?? '/following', 303);
});

app.post('/api/auth/logout', async (c) => {
  const sid = getCookie(c, config.session.cookie);
  if (sid) await q.endSession(sid);
  c.header('set-cookie', auth.sessionCookie('', { clear: true }));
  return respond(c, { redirectTo: '/' });
});

/* Passkey challenges live in Redis keyed by a short-lived cookie: a challenge is
   single-use state that must not be replayable and must not sit in a JWT. */
const challengeKey = (id) => `pk:challenge:${id}`;

async function stashChallenge(c, challenge) {
  const id = crypto.randomUUID();
  await connection.set(challengeKey(id), challenge, 'EX', 300);
  setCookie(c, 'tw_pk', id, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 300,
    secure: config.isProd,
  });
}

async function takeChallenge(c) {
  const id = getCookie(c, 'tw_pk');
  if (!id) return null;
  const val = await connection.get(challengeKey(id));
  await connection.del(challengeKey(id));
  return val;
}

app.post('/api/auth/passkey/register/options', async (c) => {
  const user = requireUser(c);
  const options = await auth.passkeyRegistrationOptions(user);
  await stashChallenge(c, options.challenge);
  return c.json(options);
});

app.post('/api/auth/passkey/register/verify', async (c) => {
  const user = requireUser(c);
  const expectedChallenge = await takeChallenge(c);
  if (!expectedChallenge) return c.json({ error: 'challenge expired' }, 400);
  const ok = await auth.verifyPasskeyRegistration({
    user,
    response: await c.req.json(),
    expectedChallenge,
  });
  return c.json({ ok }, ok ? 200 : 400);
});

/*
 * Both halves of the passkey exchange, on one counter. Asking for options is
 * unauthenticated and writes a challenge to Redis, so it is a free write anybody
 * can ask for in a loop; the verify next to it is the failed-login equivalent.
 * One bucket, because the pair is one flow and metering only half of it just
 * moves the load to the other.
 */
const passkeyBackoff = authBackoff('passkey', (c, retryAfter) =>
  c.json({ error: `Too many attempts. Try again in ${waitFor(retryAfter)}.` }, 429),
);

app.post('/api/auth/passkey/authenticate/options', passkeyBackoff);
app.post('/api/auth/passkey/authenticate/options', async (c) => {
  const options = await auth.passkeyAuthenticationOptions();
  await stashChallenge(c, options.challenge);
  return c.json(options);
});

app.post('/api/auth/passkey/authenticate/verify', passkeyBackoff);
app.post('/api/auth/passkey/authenticate/verify', async (c) => {
  const expectedChallenge = await takeChallenge(c);
  if (!expectedChallenge) return c.json({ error: 'challenge expired' }, 400);
  const result = await auth.verifyPasskeyAuthentication({
    response: await c.req.json(),
    expectedChallenge,
    userAgent: c.req.header('user-agent'),
  });
  if (!result) return c.json({ error: 'rejected' }, 400);

  const caller = callerAddress(c);
  if (caller) forgive(`passkey:${caller}`);

  c.header('set-cookie', auth.sessionCookie(result.sessionId));
  return c.json({ ok: true });
});

/**
 * Sign in with a password, for the device the other two cannot reach.
 *
 * A plain form post with no script, because the device this exists for is a
 * television: the whole point is that it works with a remote control and a browser
 * that may do very little else.
 *
 * Every failure comes back identically worded, and verifyPassword spends the same
 * time on an address with no account as on a wrong password, so this form cannot be
 * used to find out who has an account here. When it throttles, the message points at
 * the emailed link -- which is unaffected by the counter, so guessing at somebody's
 * address can never lock them out of their own account.
 */
/*
 * The backoff goes in FRONT of the handler, which is the entire point: refusing
 * here costs a map lookup, where letting it through costs an argon2id verify
 * that was sized to be expensive. A limiter that runs after the hash meters the
 * attack without stopping it paying for itself.
 */
app.post(
  '/api/auth/password',
  authBackoff('password', async (c, retryAfter) => {
    const message = `Too many sign-in attempts from here. Try again in ${waitFor(retryAfter)}, or use a sign-in link — that still works.`;
    return c.req.header('accept')?.includes('application/json')
      ? c.json({ error: message }, 429)
      : c.html(await render(<SignIn mode="login" passwordError={message} />), 429);
  }),
);
app.post('/api/auth/password', async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? '');
  const next = String(body.next ?? '/following');

  const result = await auth.verifyPassword({
    email,
    password: String(body.password ?? ''),
    userAgent: c.req.header('user-agent'),
    // Behind Railway's proxy the socket address is the proxy; the forwarded header
    // is the only thing that carries the caller. Recorded for the log, never used
    // as the rate-limit key -- a shared address would then throttle strangers.
    ip: (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || null,
  });

  if (!result.ok) {
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('application/json')) return c.json({ error: result.error }, 401);
    return c.html(
      await render(<SignIn mode="login" next={next} passwordError={result.error} />),
      401,
    );
  }

  // Whoever just proved they hold the password is not who the backoff is for.
  const caller = callerAddress(c);
  if (caller) forgive(`password:${caller}`);

  c.header('set-cookie', auth.sessionCookie(result.sessionId));
  return respond(c, { redirectTo: next });
});

/**
 * Set, change or remove a password, from inside a session.
 *
 * Deliberately only reachable while already signed in by a link or a passkey. That
 * is what keeps this from being a way to take an account over: whoever can set a
 * password here already had the session needed to do anything else anyway.
 */
app.post('/api/auth/password/set', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();

  if (body.remove === 'on' || body.remove === 'true') {
    await auth.removePassword(user.id);
    // Never a lockout: the link and any passkey still work.
    return respond(c, { json: { ok: true }, redirectTo: '/settings?password=removed' });
  }

  const password = String(body.password ?? '');
  if (password !== String(body.confirm ?? '')) {
    return respond(c, {
      json: { error: 'those did not match' },
      status: 400,
      redirectTo: `/settings?password_error=${encodeURIComponent('Those two did not match.')}`,
    });
  }

  const result = await auth.setPassword({ userId: user.id, email: user.email, password });
  if (!result.ok) {
    return respond(c, {
      json: { error: result.error },
      status: 400,
      redirectTo: `/settings?password_error=${encodeURIComponent(result.error)}`,
    });
  }
  return respond(c, { json: { ok: true }, redirectTo: '/settings?password=set' });
});

/* ----------------------------------------------------------------- follows -- */

for (const [path, fn] of [
  ['/api/follow', q.addFollow],
  ['/api/unfollow', q.removeFollow],
]) {
  app.post(path, async (c) => {
    const user = requireUser(c);
    const body = await c.req.parseBody();
    const subjectType = String(body.subject_type ?? '');
    const subjectId = Number(body.subject_id);
    if (!['team', 'league'].includes(subjectType) || !Number.isFinite(subjectId)) {
      return c.json({ error: 'bad subject' }, 400);
    }
    await fn({ userId: user.id, subjectType, subjectId });
    return respond(c, { redirectTo: String(body.next ?? '/following') });
  });
}

app.get('/api/teams/search', async (c) => {
  const term = (c.req.query('q') ?? '').trim();
  if (term.length < 2) return c.json({ results: [] });
  return c.json({ results: await q.searchTeams(term) });
});

/**
 * The box in the header.
 *
 * Not cached, and it cannot be: for a signed-in reader the answer carries their
 * own channel list and their own blocks, and those must never be served to
 * anybody else. It is also per-query, so a shared cache would be mostly misses
 * paying for the risk.
 */
app.get('/search', async (c) => {
  const user = c.get('user');
  const term = (c.req.query('q') ?? '').trim();
  const sport = (c.req.query('sport') ?? '').trim() || null;

  const results = await searchEverything(term, { userId: user?.id ?? null, sport });
  return c.html(
    await render(<SearchPage user={user} term={term} sport={sport} results={results} />),
  );
});

/**
 * The same search, as JSON.
 *
 * Public, cached and unauthenticated, so it covers the three sources that are the
 * same for everybody and leaves out the two that are not. Widening it to match the
 * page would either serve one reader's private channel list from a shared cache or
 * quietly return nothing for the sources that need a session -- both worse than an
 * endpoint that says what it covers.
 */
app.get('/api/v1/search', async (c) => {
  const term = (c.req.query('q') ?? '').trim();
  if (term.length < 2) return c.json({ error: 'q must be at least 2 characters' }, 400);
  const sport = (c.req.query('sport') ?? '').trim() || null;
  const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 50);

  const [teams, leagues, events] = await Promise.all([
    q.searchTeamsFull(term, { limit, sport }),
    q.searchLeagues(term, { sport }),
    q.searchFixtures(term, { sport }),
  ]);

  c.header('cache-control', 'public, max-age=60');
  return c.json({
    query: term,
    [brand.words.participants]: teams.map((t) => ({
      slug: t.slug,
      name: t.display_name,
      league: t.league_name,
      sport: t.sport,
      logo: t.logo_url,
      next: t.next_starts_at ?? null,
      url: `${config.siteUrl}${href.participant(t.slug)}`,
    })),
    [brand.words.collections]: leagues.map((l) => ({
      slug: l.slug,
      name: l.name,
      abbreviation: l.abbreviation,
      sport: l.sport,
      upcoming: l.upcoming,
      url: `${config.siteUrl}${href.collection(l.slug)}`,
    })),
    [brand.words.events]: events.map((e) => ({
      id: e.id,
      name: e.name,
      starts_at: e.starts_at,
      state: e.state,
      league: e.league_name,
      url: `${config.siteUrl}/events/${e.id}`,
    })),
  });
});

/* ------------------------------------------------------------------- prefs -- */

app.post('/api/prefs', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody({ all: true });
  const arr = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  await q.savePrefs({
    userId: user.id,
    offsetsMinutes: arr(body.offsets)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),
    channels: arr(body.channels)
      .map(String)
      .filter((s) => ['webpush', 'email'].includes(s)),
  });
  return respond(c, { redirectTo: '/settings' });
});

/**
 * Store the viewer's time zone.
 *
 * Only used for email, which is rendered server-side with no browser to ask. Pages
 * localise in the browser, so this is not what makes the site show the right times.
 * Accepts both the form post from settings and the automatic report from app.js.
 */
app.post('/api/timezone', async (c) => {
  const user = requireUser(c);
  const contentType = c.req.header('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await c.req.json().catch(() => ({}))
    : await c.req.parseBody();
  const timezone = String(body.timezone ?? '').trim();

  // Validate against the platform's own zone database rather than a regex: an
  // invalid zone stored here would throw inside every reminder email later.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return c.json({ error: 'unknown time zone' }, 400);
  }

  await q.setUserTimezone(user.id, timezone);
  return respond(c, { redirectTo: '/settings' });
});

app.get('/settings', async (c) => {
  const user = requireUser(c);
  const [prefs, passkeys, playlist, member, shareCandidates] = await Promise.all([
    q.getPrefs(user.id),
    q.listPasskeys(user.id),
    q.getPlaylist(user.id),
    isMember(user),
    // Fetched unconditionally rather than only for a member: the picker has to be
    // populated the instant somebody joins, and a second round trip after the
    // upgrade is how it renders empty on the one page view that matters.
    q.shareCandidates(user.id),
  ]);
  // On its own line, named, and not slotted into the array above. It was, one
  // position off from where it was destructured, and every reader was told they
  // were connected: the share-candidates list is truthy. A positional list of
  // five unrelated things is exactly where that happens; a sixth does not join it.
  const radioSession = config.radio.enabled ? await radio.storedSession(user.id) : null;
  const added = c.req.query('playlist');
  /*
   * Three outcomes, not one count.
   *
   * A save that only renamed the list, and a save whose provider file had not
   * changed, both come back without a channel count -- and both used to render as
   * "Imported NaN channels", which reads as a failure of the thing that just
   * worked.
   */
  const playlistNotice =
    added === 'renamed'
      ? 'Saved.'
      : added === 'unchanged'
        ? 'Saved. Your provider is serving the same list as last time, so your channels are unchanged.'
        : added
          ? `Imported ${Number(added).toLocaleString('en-US')} channels.`
          : null;

  // Masked here rather than in the view, so the unsealed URL exists for one
  // expression and never becomes a prop that something else could render whole.
  const playlistUrl = playlist ? auth.open(playlist.source_url) : null;
  return c.html(
    await render(
      <Settings
        user={user}
        prefs={
          prefs ?? {
            offsets_minutes: config.reminders.defaultOffsets,
            channels: ['webpush', 'email'],
          }
        }
        passkeys={passkeys}
        playlist={playlist}
        playlistMasked={playlistUrl ? maskPlaylistUrl(playlistUrl) : null}
        playlistUnreadable={Boolean(playlist) && !playlistUrl}
        playlistNotice={playlistNotice}
        playlistError={c.req.query('playlist_error') ?? null}
        profileError={c.req.query('profile_error') ?? null}
        profileSaved={c.req.query('profile') === 'saved'}
        passwordNotice={
          c.req.query('password') === 'set'
            ? 'Password saved. You can sign in with it on a device that cannot do the others.'
            : c.req.query('password') === 'removed'
              ? 'Password removed. Links and passkeys still work.'
              : null
        }
        passwordError={c.req.query('password_error') ?? null}
        passwordMinLength={auth.PASSWORD_MIN_LENGTH}
        member={member}
        shareCandidates={shareCandidates}
        radio={
          config.radio.enabled
            ? {
                session: radioSession,
                pending: radio.peekPending(user.id),
                notice: radioNoticeFor(c.req.query('siriusxm')),
                error: c.req.query('siriusxm_error') ?? null,
              }
            : null
        }
      />,
    ),
  );
});

/* --------------------------------------------------------------- radio -- */

/**
 * A reader's own SiriusXM, connected in settings and played on /radio.
 *
 * The same BYO rail as the playlist, with the same rule about what leaves the
 * server: nothing. The session is minted here with the code SiriusXM emails
 * the reader, stored sealed, and every byte of audio is fetched by us as that
 * reader and handed to that reader's browser. There is no address to copy
 * because the addresses only work with the bearer.
 */

function radioNoticeFor(state) {
  switch (state) {
    case 'code':
      return 'SiriusXM has sent a code to that address. Enter it below.';
    case 'connected':
      return 'SiriusXM connected. The lineup is on the Radio page.';
    case 'removed':
      return 'SiriusXM disconnected.';
    default:
      return null;
  }
}

const radioBack = (query) => `/settings?${query}#siriusxm`;

/**
 * The reader's problem or ours, in the status. A SiriusXmError knows which;
 * anything else is ours and must not read as "wrong code".
 */
function radioFailure(err) {
  if (err instanceof radio.SiriusXmError) {
    // Logged as well as shown: the page gets the sentence, the log gets what
    // SXM actually said, which is the only way a failed sign-in is diagnosable
    // from here without the reader's screen.
    console.warn(
      `[radio] ${err.status} ${err.message}${err.data ? ` -- ${JSON.stringify(err.data).slice(0, 300)}` : ''}`,
    );
    return { message: err.message, status: err.status };
  }
  console.error('[radio]', err);
  return { message: 'SiriusXM did not answer. Try again in a moment.', status: 502 };
}

app.post('/api/radio/connect', async (c) => {
  const user = requireUser(c);
  if (!config.radio.enabled) return c.json({ error: 'radio is off' }, 404);
  const body = await c.req.parseBody();
  const email = String(body.email ?? '').trim();
  if (!email.includes('@')) {
    return respond(c, {
      json: { error: 'Enter the email on your SiriusXM account.' },
      status: 400,
      redirectTo: radioBack('siriusxm_error=Enter%20the%20email%20on%20your%20SiriusXM%20account.'),
    });
  }
  try {
    const state = await radio.startOtpLogin(email, {
      proxy: radio.proxyFor(user.id),
      deviceGrant: config.radio.deviceGrant || null,
    });
    radio.putPending(user.id, { ...state, email });
    return respond(c, { json: { ok: true, step: 'code' }, redirectTo: radioBack('siriusxm=code') });
  } catch (err) {
    const { message, status } = radioFailure(err);
    return respond(c, {
      json: { error: message },
      status,
      redirectTo: radioBack(`siriusxm_error=${encodeURIComponent(message)}`),
    });
  }
});

app.post('/api/radio/connect/verify', async (c) => {
  const user = requireUser(c);
  if (!config.radio.enabled) return c.json({ error: 'radio is off' }, 404);
  const body = await c.req.parseBody();
  // Pasted codes arrive as "1 2 3 4 5 6" or wrapped from an email; SXM wants digits.
  const otp = String(body.otp ?? '').replace(/\s+/g, '');
  const pending = radio.takePending(user.id);
  if (!pending) {
    const message = 'That code has expired. Send a new one.';
    return respond(c, {
      json: { error: message },
      status: 400,
      redirectTo: radioBack(`siriusxm_error=${encodeURIComponent(message)}`),
    });
  }
  if (!otp) {
    // The jar is consumed by takePending; put it back so a blank submit is not
    // a restart.
    radio.putPending(user.id, pending);
    const message = 'Enter the code from the email.';
    return respond(c, {
      json: { error: message },
      status: 400,
      redirectTo: radioBack(`siriusxm_error=${encodeURIComponent(message)}`),
    });
  }
  try {
    const session = await radio.completeOtpLogin(pending, otp, { proxy: radio.proxyFor(user.id) });
    await radio.saveSession(user.id, { email: pending.email, ...session });
    return respond(c, {
      json: { ok: true, connected: true },
      redirectTo: radioBack('siriusxm=connected'),
    });
  } catch (err) {
    const { message, status } = radioFailure(err);
    // A wrong code does not spend the sign-in: the jar goes back so the reader
    // can try the code again rather than asking for a new one.
    if (status === 400) radio.putPending(user.id, pending);
    return respond(c, {
      json: { error: message },
      status,
      redirectTo: radioBack(`siriusxm_error=${encodeURIComponent(message)}`),
    });
  }
});

app.post('/api/radio/connect/cancel', async (c) => {
  const user = requireUser(c);
  radio.dropPending(user.id);
  return respond(c, { json: { ok: true }, redirectTo: '/settings#siriusxm' });
});

app.post('/api/radio/disconnect', async (c) => {
  const user = requireUser(c);
  radio.dropPending(user.id);
  await radio.disconnect(user.id);
  return respond(c, { json: { ok: true }, redirectTo: radioBack('siriusxm=removed') });
});

/** Rendered per request and never cached: the lineup is the same for everyone, the session is not. */
app.get('/radio', async (c) => {
  const user = c.get('user');
  if (!config.radio.enabled) return c.html(await render(<NotFound user={user} />), 404);
  const cat = radio.CATEGORIES.includes(c.req.query('cat')) ? c.req.query('cat') : 'sports';
  const qText = (c.req.query('q') ?? '').trim().slice(0, 80);
  const session = user ? await radio.storedSession(user.id) : null;
  let channels = [];
  let error = null;
  if (session && !session.unreadable) {
    try {
      channels = qText ? await radio.search(user.id, qText) : await radio.channels(user.id, cat);
    } catch (err) {
      error = radioFailure(err).message;
    }
  }
  c.header('cache-control', 'private, no-store');
  return c.html(
    await render(
      <RadioPage
        user={user}
        session={session}
        cat={cat}
        q={qText}
        channels={channels}
        error={error}
      />,
    ),
  );
});

/**
 * The team feeds for a fixture or a team, as rows.
 *
 * `?event=` looks up both sides; `?team=` one team. Only for a league SiriusXM
 * carries by team -- anything else is 404, and the page never drew the section
 * to ask. Each side is searched on the reader's own session, cached across
 * readers, and settled separately so one side failing does not empty the
 * other. Answered as HTML because the row has one template, on the server.
 */
app.get('/radio/find', async (c) => {
  const user = requireUser(c);
  if (!config.radio.enabled) return c.text('radio is off', 404);
  const fragment = (node) =>
    c.body(node, 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
    });

  let leagueSlug = null;
  let sides = [];
  if (c.req.query('event')) {
    const event = await q.getEvent(Number(c.req.query('event')));
    if (!event) return c.text('no such fixture', 404);
    leagueSlug = event.league_slug;
    const teams = await q.teamNamesByIds([event.home_team_id, event.away_team_id]);
    // In fixture order, home first, with the provider's own nickname when the
    // row is there and the display name alone when it is not.
    sides = [event.home_team_id, event.away_team_id]
      .map(
        (id, i) => teams.find((t) => t.id === id) ?? (i === 0 ? event.home_name : event.away_name),
      )
      .filter(Boolean);
  } else if (c.req.query('team')) {
    const [team] = await q.teamNamesByIds([c.req.query('team')]);
    if (!team) return c.text('no such team', 404);
    leagueSlug = team.league_slug;
    sides = [team];
  }
  if (!radio.hasTeamRadio(leagueSlug))
    return c.text('SiriusXM has no team feeds for this league.', 404);
  if (sides.length === 0) return c.text('This fixture has no sides to look up.', 404);

  try {
    const result = await radio.sidesStations(user.id, leagueSlug, sides);
    return fragment(await (<RadioSidesFragment sides={result} />).toString());
  } catch (err) {
    const { message, status } = radioFailure(err);
    return c.text(message, status);
  }
});

/**
 * Where a same-origin address for an SXM resource is minted. Root-relative so
 * the browser resolves it against the page it is on; nothing here needs to
 * know the public hostname.
 */
const radioProxyUrl = (target, quality) =>
  `/radio/proxy?u=${encodeURIComponent(target)}&quality=${encodeURIComponent(quality)}`;

const radioQuality = (value) => (radio.QUALITIES.includes(value) ? value : radio.DEFAULT_QUALITY);

/**
 * Fetch one SXM resource as the reader, at most once for everyone asking.
 *
 * Through the reader's pinned proxy, because the tune URL was minted from
 * that IP and the key endpoint checks. Manifests and keys are small; a segment
 * is a few seconds of audio; all are buffered so `sharedFetch` can hand the
 * same bytes to a second tab without a second upstream request.
 */
async function radioFetch(userId, target) {
  return radio.sharedFetch(target, async () => {
    const res = await radio.sxmFetch(
      target,
      {
        headers: {
          ...radio.API_HEADERS,
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
          Authorization: `Bearer ${await radio.bearerFor(userId)}`,
        },
      },
      { proxy: radio.proxyFor(userId) },
    );
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: await res.arrayBuffer(),
    };
  });
}

/** The reply for a manifest, a key or a segment, from what SXM sent. */
function radioResource(c, target, quality, upstream) {
  if (upstream.status < 200 || upstream.status >= 300) {
    if (upstream.status === 401 || upstream.status === 403) radio.forget(c.get('user').id);
    return c.text(`SiriusXM answered ${upstream.status}`, upstream.status === 404 ? 404 : 502);
  }
  const ct = upstream.contentType ?? '';
  if (radio.isKeyUrl(target)) {
    // The AES key arrives as JSON; the player needs the sixteen bytes.
    let key;
    try {
      key = radio.decodeKeyJson(JSON.parse(new TextDecoder().decode(upstream.body)));
    } catch (err) {
      return c.text(`key decode failed: ${err.message}`, 502);
    }
    return c.body(key, 200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store, private',
    });
  }
  if (radio.looksLikePlaylist(target, ct)) {
    const text = new TextDecoder().decode(upstream.body);
    const rewritten = radio.rewritePlaylist(text, target, quality, (u) =>
      radioProxyUrl(u, quality),
    );
    return c.body(rewritten, 200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store, private',
    });
  }
  return c.body(upstream.body, 200, {
    'content-type': ct || 'application/octet-stream',
    'cache-control': 'no-store, private',
    'x-accel-buffering': 'no',
  });
}

/**
 * The playlist the player is handed: a station id in, a rewritten manifest out.
 *
 * The tune URL never reaches the browser. It is minted here, held for its own
 * lifetime, and every address inside the manifest it fetches is rewritten to
 * /radio/proxy before the bytes leave.
 */
app.get('/radio/stream.m3u8', async (c) => {
  const user = requireUser(c);
  if (!config.radio.enabled) return c.json({ error: 'radio is off' }, 404);
  const parsed = radio.parseStationId(c.req.query('id') ?? '');
  if (!parsed) return c.json({ error: 'no such station' }, 400);
  const quality = radioQuality(c.req.query('quality'));
  try {
    const target = await radio.tune(user.id, parsed);
    const upstream = await radioFetch(user.id, target);
    return radioResource(c, target, quality, upstream);
  } catch (err) {
    const { message, status } = radioFailure(err);
    return c.json({ error: message }, status);
  }
});

/**
 * Everything the manifest points at. The target is checked against SXM's own
 * hosts before anything is fetched: this route carries a bearer, and a bearer
 * sent to an address a reader chose is a bearer handed to that reader.
 */
app.get('/radio/proxy', async (c) => {
  const user = requireUser(c);
  if (!config.radio.enabled) return c.json({ error: 'radio is off' }, 404);
  const target = c.req.query('u') ?? '';
  if (!radio.isSiriusXmUrl(target)) return c.text('forbidden target', 403);
  const quality = radioQuality(c.req.query('quality'));
  try {
    const upstream = await radioFetch(user.id, target);
    return radioResource(c, target, quality, upstream);
  } catch (err) {
    const { message, status } = radioFailure(err);
    return c.text(message, status);
  }
});

/**
 * Notification self-check.
 *
 * Deliberately open to signed-out visitors: the failure it diagnoses happens in the
 * browser, before anything is saved, so requiring an account only adds a step
 * between someone and the answer.
 */
app.get('/push-check', (c) =>
  c.html(render(<PushCheck user={c.get('user')} vapidKey={config.push.publicKey} />)),
);

/**
 * Where the self-check reports to.
 *
 * Logged, never stored: the point is that a support conversation can start from what
 * the browser actually did rather than from a screenshot. Bounded because anything
 * a browser can post unauthenticated can be posted a million times.
 */
app.post('/api/push/diag', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const trimmed = JSON.stringify(body).slice(0, 600);
  console.log('[push-diag]', trimmed);
  return c.json({ ok: true });
});

app.post('/api/push/subscribe', async (c) => {
  const user = requireUser(c);
  const sub = await c.req.json();
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return c.json({ error: 'malformed subscription' }, 400);
  }
  await q.savePushSubscription({
    userId: user.id,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
  });
  return c.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (c) => {
  const user = requireUser(c);
  const body = await c.req.json().catch(() => ({}));
  if (!body?.endpoint) return c.json({ error: 'endpoint required' }, 400);
  await q.deletePushSubscription({ userId: user.id, endpoint: body.endpoint });
  return c.json({ ok: true });
});

/* ---------------------------------------------------------------- payments -- */

app.post('/api/events/:id/buy', async (c) => {
  const user = requireUser(c);
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.json({ error: 'no such event' }, 404);

  const body = await c.req.parseBody();
  const [offer] = (await q.offersForEvent(event.id)).filter((o) => o.id === Number(body.offer_id));
  if (!offer) return c.json({ error: 'offer unavailable' }, 409);

  /*
   * What is being bought is described HERE, not in the payments package.
   *
   * That package is copied verbatim between brands, so it takes an amount, a
   * description and a metadata bag rather than knowing what an offer is. The
   * metadata is echoed back on the webhook and is the only thing linking the money
   * to this fixture and this seat.
   */
  const { checkoutUrl } = await pay.createCheckout({
    user,
    amountCents: offer.price_cents,
    currency: offer.currency,
    description: `Stream: ${event.name}`,
    metadata: { event_id: String(event.id), offer_id: String(offer.id) },
    blockchain: config.payments.blockchain,
    /*
     * Normally undefined, and that is right: the upstream then forwards to this
     * business's own wallet for the chain, and refuses the payment outright if
     * none is configured. Set only to pay somebody who is not this business.
     */
    payTo: config.payments.payoutAddress || undefined,
    successUrl: `${config.siteUrl}/events/${event.id}?paid=1`,
    cancelUrl: `${config.siteUrl}/events/${event.id}`,
  });
  return respond(c, { json: { checkoutUrl }, redirectTo: checkoutUrl });
});

/**
 * The original half of the webhook: one seat at one fixture.
 *
 * Unchanged in behaviour and moved out of the callback only so the membership
 * branch beside it is legible. Returns null for anything it cannot attribute,
 * which declines the grant without failing the webhook.
 */
async function grantStreamSeat(tx, { meta, payment }) {
  const eventId = Number(meta.event_id);
  const offerId = Number(meta.offer_id);
  if (!Number.isFinite(eventId)) return null;

  if (Number.isFinite(offerId) && !(await q.claimOfferSeat(tx, offerId))) return null;

  const startsAt = await q.eventStartsAt(tx, eventId);
  if (!startsAt) return null;

  // Access dies with the game plus a grace window. There is no perpetual licence
  // to a live stream, and an open-ended grant is what turns a small sale into
  // redistribution.
  const expiresAt = new Date(
    new Date(startsAt).getTime() + config.payments.entitlementGraceHours * 3600_000,
  );

  return pay.grantEventEntitlement(tx, {
    userId: meta.user_id,
    eventId,
    offerId: Number.isFinite(offerId) ? offerId : null,
    paymentId: payment?.id ?? null,
    expiresAt,
  });
}

/**
 * CoinPay webhook. Signature is over the RAW bytes, so the body is read as text
 * before anything parses it -- re-serialising the JSON changes the bytes and the
 * signature stops matching.
 */
app.post('/api/webhooks/coinpay', async (c) => {
  const raw = await c.req.text();
  const ok = pay.verifyWebhook({
    rawBody: raw,
    signatureHeader: c.req.header('coinpay-signature') ?? c.req.header('x-coinpay-signature'),
  });
  if (!ok) return c.json({ error: 'bad signature' }, 401);

  /*
   * The grant is supplied by this app, because only this app knows what was sold.
   *
   * It runs inside settleWebhook's transaction, so claiming the seat and writing
   * the entitlement are one decision -- which is what stops two buyers being sold
   * the last seat at once.
   */
  const result = await pay.settleWebhook(JSON.parse(raw), {
    grant: async (tx, { meta, payment }) => {
      /*
       * Two things are sold through one webhook, and only the metadata says which.
       *
       * The settled payload carries no product of its own -- it is an amount and a
       * status -- so `kind` is the entire difference between granting a year of
       * membership and granting a seat at a fixture. A payment that arrives with
       * neither is not attributable to anything and grants nothing.
       */
      const granted =
        meta.kind === member.MEMBERSHIP_KIND
          ? await member.grantMembership(tx, {
              userId: meta.user_id,
              paymentId: payment?.id ?? null,
              // What we CHARGED, from our own row, rather than what the payload
              // says was paid. A term is a term whatever the wire claims.
              priceCents: payment?.amount_cents ?? config.membership.priceCents,
              currency: payment?.currency ?? config.membership.currency,
              termDays: config.membership.termDays,
            })
          : await grantStreamSeat(tx, { meta, payment });

      // Nothing was delivered, so nothing is owed to anybody. Returning null here
      // records the money and declines the grant, which is what settleWebhook's
      // "grant declined" branch is for.
      if (!granted) return null;

      /*
       * The introduction is paid AFTER something was actually delivered, and in
       * the same transaction as the delivery.
       *
       * Ordering matters both ways round. Crediting first would pay a commission
       * on a sold-out fixture nobody received; crediting in a second transaction
       * would leave a window where the sale exists and the commission owed on it
       * does not. Returns null when nobody invited this buyer, which is the common
       * case and must never fail a webhook.
       */
      const commission = await member.creditReferral(tx, {
        buyerId: meta.user_id,
        paymentId: payment?.id ?? null,
        amountCents: payment?.amount_cents ?? 0,
        currency: payment?.currency ?? config.membership.currency,
        rateBps: config.membership.commissionBps,
      });

      return { ...granted, commissionCents: commission?.amount_cents ?? 0 };
    },
  });
  return c.json(result);
});

/* ------------------------------------------------------------- membership -- */

/**
 * The page that sells the tier, and the page that reports on it.
 *
 * One page rather than two, because "what do I get" and "what have I earned" are
 * the same question asked before and after joining, and splitting them means a
 * member lands on a sales pitch every time they want to check their balance.
 *
 * Readable signed out: somebody has to be able to find out what this costs before
 * making an account. Everything account-shaped below is fetched only when there is
 * an account to fetch it for.
 */
app.get('/premium', async (c) => {
  const user = c.get('user');

  const [membership, earnings, invited, ledger, code] = user
    ? await Promise.all([
        q.activeMembership(user.id),
        q.commissionSummary(user.id),
        q.invitedAccounts(user.id),
        q.commissionLedger(user.id, { limit: 20 }),
        invites.inviteCodeFor(user.id),
      ])
    : [null, [], [], [], null];

  return c.html(
    await render(
      <PremiumPage
        user={user}
        membership={membership}
        priceCents={config.membership.priceCents}
        currency={config.membership.currency}
        termDays={config.membership.termDays}
        commissionBps={config.membership.commissionBps}
        freeHistoryDays={config.membership.freeMessageHistoryDays}
        paymentsEnabled={pay.paymentsEnabled()}
        inviteUrl={code ? invites.inviteUrl(code) : null}
        invited={invited}
        earnings={earnings}
        ledger={ledger}
        payout={user}
        want={c.req.query('want') ?? null}
        notice={
          c.req.query('paid') === '1'
            ? 'Payment started. Membership begins the moment it settles on chain, which is usually a few minutes.'
            : c.req.query('payout') === 'saved'
              ? 'Payout details saved.'
              : null
        }
        error={c.req.query('error') ?? null}
      />,
    ),
  );
});

/**
 * Buy a term.
 *
 * Renewing is the same call as joining and needs no special case: the grant stacks
 * the new term onto the end of whatever is already held, so pressing this twice
 * costs twice and grants twice as long rather than overwriting anything.
 *
 * Nothing is checked about whether they are already a member. Refusing a renewal
 * because one is running would mean somebody can only extend in the last hour of
 * their year, which is a worse failure than letting them pay early.
 */
app.post('/api/membership/buy', async (c) => {
  const user = requireUser(c);

  if (!pay.paymentsEnabled()) {
    return respond(c, {
      json: { error: 'payments are off' },
      status: 503,
      redirectTo: '/premium?error=Payments%20are%20not%20switched%20on%20here.',
    });
  }

  /*
   * `kind` is what the webhook will branch on, and it is the only thing that makes
   * this payment a membership rather than a seat at a fixture. A checkout that
   * omitted it would settle, be recorded, and grant nothing at all.
   */
  const { checkoutUrl } = await pay.createCheckout({
    user,
    amountCents: config.membership.priceCents,
    currency: config.membership.currency,
    description: `${brand.name} premium, ${config.membership.termDays} days`,
    metadata: { kind: member.MEMBERSHIP_KIND },
    blockchain: config.payments.blockchain,
    payTo: config.payments.payoutAddress || undefined,
    successUrl: `${config.siteUrl}/premium?paid=1`,
    cancelUrl: `${config.siteUrl}/premium`,
  });

  return respond(c, { json: { checkoutUrl }, redirectTo: checkoutUrl });
});

/**
 * Where to send this account's commission.
 *
 * Not validated against the chain beyond being present, deliberately: this site
 * does not know how to check an address on every chain CoinPay settles, and a
 * validator that is wrong about one of them would refuse a correct address with
 * no way past it. Payouts are settled by a human who can look.
 */
app.post('/api/membership/payout', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();
  await q.setPayoutInstruction({
    userId: user.id,
    address: body.address,
    chain: body.chain,
  });
  return respond(c, { json: { ok: true }, redirectTo: '/premium?payout=saved' });
});

/* ---------------------------------------------------------------- invites -- */

/**
 * Somebody has opened an invite link.
 *
 * The code is parked in a cookie rather than carried through the sign-up flow,
 * because the account is created at the end of a magic-link round trip through an
 * email client and nothing else survives that. Lax rather than strict: the return
 * trip is a top-level navigation from an outside origin, and a strict cookie is
 * not sent on it -- which would silently credit nobody.
 *
 * No account is required and none is created here. A link is an invitation, not an
 * action.
 */
app.get('/i/:code', (c) => {
  const code = String(c.req.param('code') ?? '').slice(0, 64);
  if (code) {
    setCookie(c, invites.INVITE_COOKIE, code, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: invites.INVITE_COOKIE_MAX_AGE,
      secure: config.isProd,
    });
  }
  return c.redirect('/signup?invited=1', 302);
});

app.get('/invite', async (c) => {
  const user = requireUser(c);
  const [code, invited] = await Promise.all([
    invites.inviteCodeFor(user.id),
    q.invitedAccounts(user.id),
  ]);

  const sent = Number(c.req.query('sent') ?? 0);
  return c.html(
    await render(
      <InvitePage
        user={user}
        inviteUrl={invites.inviteUrl(code)}
        invited={invited}
        dailyLimit={invites.DAILY_SEND_LIMIT}
        maxPerSubmission={invites.MAX_PER_SUBMISSION}
        mailEnabled={config.mail.enabled}
        sentNotice={sent > 0 ? `Sent ${sent} ${sent === 1 ? 'invitation' : 'invitations'}.` : null}
        error={c.req.query('invite_error') ?? null}
      />,
    ),
  );
});

/**
 * Email the invite link to some addresses.
 *
 * Every limit lives in the invites module, not here -- this route's whole job is
 * to hand it the addresses and a mailer. The result is a count rather than a
 * per-address outcome, which is what keeps this from becoming the account checker
 * the sign-in page is careful not to be.
 */
app.post('/api/invite/email', async (c) => {
  const user = requireUser(c);
  const body = await c.req.parseBody();

  const result = await invites.sendInvites({
    user,
    raw: body.emails,
    send: sendInviteEmail,
  });

  if (!result.ok) {
    return respond(c, {
      json: { error: result.error },
      status: 429,
      redirectTo: `/invite?invite_error=${encodeURIComponent(result.error)}`,
    });
  }
  return respond(c, { json: result, redirectTo: `/invite?sent=${result.sent}` });
});

/* -------------------------------------------------------------- public API -- */

/**
 * Free, unauthenticated, documented at its own root.
 *
 * The calendar is public data we already hold; making it readable by a script costs
 * nothing and is the cheapest distribution this app has. Every response is bounded
 * and cacheable.
 */
app.get('/api/v1', async (c) => {
  const stats = await q.catalogueStats();
  return c.json({
    name: `${brand.name} API`,
    version: 1,
    documentation: `${config.siteUrl}/api/v1`,
    license: 'Free to use, no key required. Be reasonable.',
    catalogue: stats,
    endpoints: {
      'GET /api/v1/sports': 'Every sport, with league counts.',
      'GET /api/v1/leagues?sport=soccer': 'Leagues, optionally filtered by sport.',
      'GET /api/v1/events?league=soccer-eng-1&sport=soccer&limit=100':
        'Upcoming fixtures. Both filters optional; limit caps at 200.',
    },
  });
});

app.get('/api/v1/sports', async (c) => {
  c.header('cache-control', 'public, max-age=300');
  return c.json({ sports: await q.listSports() });
});

app.get('/api/v1/leagues', async (c) => {
  const leagues = await q.listLeagues({ sport: c.req.query('sport') ?? null, limit: 1000 });
  c.header('cache-control', 'public, max-age=300');
  return c.json({
    leagues: leagues.map((l) => ({
      slug: l.slug,
      name: l.name,
      sport: l.sport,
      abbreviation: l.abbreviation,
      logo: l.logo_url,
    })),
  });
});

app.get('/api/v1/events', async (c) => {
  const events = await q.publicEvents({
    leagueSlug: c.req.query('league') ?? null,
    sport: c.req.query('sport') ?? null,
    limit: c.req.query('limit') ?? 100,
  });
  c.header('cache-control', 'public, max-age=60');
  return c.json({ count: events.length, events });
});

/*
 * The three pages a reader is entitled to and the site did not have.
 *
 * Cached like any other page that is identical for everyone. They are static, so
 * the TTL is long -- but they go through cached() rather than being served as
 * strings so the signed-in header still renders for whoever is signed in.
 */
app.get('/privacy', (c) =>
  cached(c, 'page:privacy', 86400, () => render(<Privacy user={c.get('user')} />)),
);

app.get('/terms', (c) =>
  cached(c, 'page:terms', 86400, () => render(<Terms user={c.get('user')} />)),
);

app.get('/contact', (c) =>
  cached(c, 'page:contact', 86400, () => render(<Contact user={c.get('user')} />)),
);

app.get('/about', async (c) => {
  const stats = await q.catalogueStats();
  return c.html(await render(<About user={c.get('user')} stats={stats} />));
});

/* --------------------------------------------------------------- comments -- */

/** Enough to say something, not enough to paste an essay. */
const COMMENT_MAX = 2000;
/** Per minute. Generous for a conversation, hostile to a script. */
const COMMENT_RATE = 6;

app.post('/api/events/:id/comments', async (c) => {
  const user = requireUser(c);
  const eventId = Number(c.req.param('id'));
  if (!Number.isFinite(eventId)) return c.json({ error: 'bad event' }, 400);

  const body = await c.req.parseBody();
  const text = String(body.body ?? '').trim();
  if (!text) return c.json({ error: 'Say something first.' }, 400);
  if (text.length > COMMENT_MAX) {
    return c.json({ error: `Keep it under ${COMMENT_MAX} characters.` }, 400);
  }

  // Checked against the database rather than memory: the limit has to survive a
  // redeploy and apply across every instance, not per-process.
  if ((await q.recentCommentCount(user.id)) >= COMMENT_RATE) {
    return c.json({ error: 'Slow down a moment.' }, 429);
  }

  await q.insertComment({ eventId, userId: user.id, body: text });
  return respond(c, { redirectTo: `/events/${eventId}#comments` });
});

app.post('/api/comments/:id/delete', async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param('id'));
  // Scoped to the author in the query, so a guessed id deletes nothing.
  await q.deleteComment({ commentId: id, userId: user.id });
  return respond(c, { redirectTo: c.req.header('referer') ?? '/' });
});

/* ------------------------------------------------------------ calendar --- */

/**
 * Calendar subscriptions.
 *
 * Calendar clients poll a URL on a schedule with no cookies, so the URL itself
 * carries the authority: a per-user token, separate from the session so it can be
 * rotated without signing anyone out.
 *
 * The path uses a plain param validated in the handler rather than an inline
 * pattern -- Hono's brace syntax swallows a {n} quantifier and the route then
 * silently never matches.
 */
app.get('/calendar/me/:file', async (c) => {
  const m = /^([0-9a-f-]{36})\.ics$/i.exec(c.req.param('file'));
  if (!m) return c.notFound();

  const user = await q.userByCalendarToken(m[1]);
  // Deliberately identical to a bad token: a 401 here would confirm which tokens
  // exist to anyone enumerating them.
  if (!user) return c.notFound();

  const events = await q.upcomingForUser(user.id, { limit: 200 });
  c.header('content-type', 'text/calendar; charset=utf-8');
  c.header('cache-control', 'private, max-age=300');
  c.header('content-disposition', 'inline; filename="tipoffwatch.ics"');
  return c.body(buildCalendar(events, { name: 'TipoffWatch — my games', siteUrl: config.siteUrl }));
});

/** A whole league's fixtures, public and shareable. */
app.get('/calendar/league/:file', async (c) => {
  const m = /^([a-z0-9._-]+)\.ics$/i.exec(c.req.param('file'));
  if (!m) return c.notFound();
  const league = await q.getLeagueBySlug(m[1]);
  if (!league) return c.notFound();

  const events = await q.upcomingForLeague(league.id, { limit: 200 });
  c.header('content-type', 'text/calendar; charset=utf-8');
  c.header('cache-control', 'public, max-age=900');
  return c.body(
    buildCalendar(events, { name: `TipoffWatch — ${league.name}`, siteUrl: config.siteUrl }),
  );
});

/** Rotating invalidates every calendar URL already handed out. */
app.post('/api/calendar/rotate', async (c) => {
  const user = requireUser(c);
  await q.rotateCalendarToken(user.id);
  return respond(c, { redirectTo: '/following' });
});

/* ---------------------------------------------------------------- feeds -- */

const feedHeaders = (c, seconds) => {
  c.header('content-type', 'application/rss+xml; charset=utf-8');
  c.header('cache-control', `public, max-age=${seconds}`);
};

app.get('/feeds/all.xml', async (c) => {
  const events = await q.feedEvents({ limit: 150 });
  feedHeaders(c, 300);
  return c.body(
    buildFeed(events, {
      title: 'TipoffWatch — every sport',
      description: 'Upcoming fixtures across 354 leagues and 17 sports.',
      feedUrl: `${config.siteUrl}/feeds/all.xml`,
      siteUrl: config.siteUrl,
    }),
  );
});

/**
 * What a feed is called, or null if nobody publishes under that name.
 *
 * The name is resolved from the catalogue rather than from the fixtures, so a
 * subject that is real but out of season still has a feed. See the route below.
 */
const feedSubjectName = async (scope, key) => {
  if (scope === 'league') return (await q.getLeagueBySlug(key))?.name ?? null;
  if (scope === 'team') return (await q.getTeamBySlug(key))?.display_name ?? null;
  return (await q.sportExists(key)) ? key.replace(/-/g, ' ') : null;
};

/**
 * One route for sport, league and team feeds.
 *
 * Separate routes would be three near-identical handlers; the scope is validated
 * against a fixed set so the path cannot select an arbitrary column.
 *
 * The subject is resolved BEFORE its fixtures, the way /calendar/league does, and
 * only an unknown name is a 404. Deciding on the fixtures instead -- no upcoming
 * events, therefore not found -- reads as the same rule but is not: most of the
 * catalogue is out of season most of the year, so it 404'd real sports for months
 * at a time. That broke the /feeds directory and the feed sitemap, which link every
 * sport in the catalogue, and it breaks any reader already subscribed, which sees a
 * dead feed rather than a quiet one. An empty channel is valid RSS and is the honest
 * answer: nothing is scheduled yet.
 */
app.get('/feeds/:scope/:file', async (c) => {
  const scope = c.req.param('scope');
  const m = /^([a-z0-9._-]+)\.xml$/i.exec(c.req.param('file'));
  if (!m || !['sport', 'league', 'team'].includes(scope)) return c.notFound();
  const key = m[1];

  const label = await feedSubjectName(scope, key);
  if (!label) return c.notFound();

  const events = await q.feedEvents({
    sport: scope === 'sport' ? key : null,
    leagueSlug: scope === 'league' ? key : null,
    teamSlug: scope === 'team' ? key : null,
    limit: 150,
  });

  feedHeaders(c, 300);
  return c.body(
    buildFeed(events, {
      title: `TipoffWatch — ${label}`,
      description: `Upcoming fixtures for ${label}.`,
      feedUrl: `${config.siteUrl}/feeds/${scope}/${key}.xml`,
      siteUrl: config.siteUrl,
      link: scope === 'league' ? `${config.siteUrl}${href.collection(key)}` : config.siteUrl,
    }),
  );
});

app.get('/feeds', async (c) =>
  cached(c, 'page:feeds', 900, async () => {
    const [sports, leagues] = await Promise.all([q.listSports(), q.leaguesWithUpcoming(120)]);
    return render(<Feeds user={c.get('user')} sports={sports} leagues={leagues} />);
  }),
);

/* ---------------------------------------------------------------- sitemaps -- */

/**
 * A sitemap index, not one file.
 *
 * The house pattern: chunks are keyed by month because a past month is immutable,
 * so a crawler can skip it on <lastmod> alone. Chunking by position instead would
 * shift every URL into a different file the moment one fixture is added, and every
 * chunk would look changed on every crawl.
 */
const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
const iso = (d) => new Date(d).toISOString();

app.get('/sitemap.xml', async (c) => {
  const months = await q.eventMonths();
  const urls = [
    `<sitemap><loc>${config.siteUrl}/sitemaps/static.xml</loc></sitemap>`,
    `<sitemap><loc>${config.siteUrl}/sitemaps/leagues.xml</loc></sitemap>`,
    `<sitemap><loc>${config.siteUrl}/sitemaps/feeds.xml</loc></sitemap>`,
    `<sitemap><loc>${config.siteUrl}/sitemaps/profiles.xml</loc></sitemap>`,
    ...months.map(
      (m) =>
        `<sitemap><loc>${config.siteUrl}/sitemaps/events-${m.month}.xml</loc>` +
        (m.lastmod ? `<lastmod>${iso(m.lastmod)}</lastmod>` : '') +
        '</sitemap>',
    ),
  ];
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</sitemapindex>`,
  );
});

app.get('/sitemaps/static.xml', (c) => {
  // /login and /signup are Disallowed in robots.txt, so listing them here asked a
  // crawler to fetch what the same site had just told it not to.
  const paths = [
    '/',
    href.category(),
    '/about',
    '/feeds',
    '/premium',
    '/contact',
    '/privacy',
    '/terms',
  ];
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
      .map(
        (p) =>
          `<url><loc>${config.siteUrl}${p}</loc><changefreq>${p === '/' ? 'hourly' : 'weekly'}</changefreq><priority>${p === '/' ? '1.0' : '0.6'}</priority></url>`,
      )
      .join('')}</urlset>`,
  );
});

/**
 * Feeds are the distribution surface, so a crawler should find them as pages
 * rather than stumble on them.
 */
app.get('/sitemaps/feeds.xml', async (c) => {
  const [sports, leagues] = await Promise.all([q.listSports(), q.leaguesWithUpcoming(400)]);
  const urls = [
    '/feeds',
    '/feeds/all.xml',
    ...sports.map((s) => `/feeds/sport/${s.sport}.xml`),
    ...leagues.map((l) => `/feeds/league/${l.slug}.xml`),
  ];
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
      .map((u) => `<url><loc>${config.siteUrl}${u}</loc><changefreq>hourly</changefreq></url>`)
      .join('')}</urlset>`,
  );
});

app.get('/sitemaps/leagues.xml', async (c) => {
  const leagues = await q.listLeagues({ limit: 1000 });
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${leagues
      .map(
        (l) =>
          `<url><loc>${config.siteUrl}${href.collection(l.slug)}</loc><changefreq>daily</changefreq></url>`,
      )
      .join('')}</urlset>`,
  );
});

// One plain param rather than a regex route: Hono's inline pattern syntax uses braces
// for the constraint, so a {4} quantifier inside it terminates the pattern early and
// the route silently never matches. Validating in the handler is unambiguous.
app.get('/sitemaps/:file', async (c) => {
  const file = c.req.param('file');

  /**
   * Public profiles.
   *
   * Priority is left off deliberately: a profile is not more or less important
   * than a fixture, and every search engine that ever used the field ignores it
   * now. lastmod is the account's creation, which is the only timestamp a profile
   * row actually has -- claiming a fresher one on every crawl would be a lie that
   * teaches the crawler to stop trusting the field.
   */
  if (file === 'profiles.xml') {
    const people = await q.publicProfiles();
    c.header('content-type', 'application/xml');
    return c.body(
      `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${people
        .map(
          (p) =>
            `<url><loc>${config.siteUrl}/u/${encodeURIComponent(p.handle)}</loc>` +
            (p.created_at ? `<lastmod>${iso(p.created_at)}</lastmod>` : '') +
            '</url>',
        )
        .join('')}</urlset>`,
    );
  }

  const m = /^events-(\d{4}-\d{2})\.xml$/.exec(file);
  if (!m) return c.notFound();

  const events = await q.eventsForMonth(m[1]);
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${events
      .map(
        (e) =>
          `<url><loc>${config.siteUrl}/events/${e.id}</loc><lastmod>${iso(e.updated_at)}</lastmod></url>`,
      )
      .join('')}</urlset>`,
  );
});

/* ------------------------------------------------------------------ static -- */

/**
 * Colours track the stylesheet's ground, not the generator's white default -- an
 * installed PWA whose splash is white flashes bright before a dark app paints.
 *
 * `maskable` is its own entry rather than a second purpose on the full-bleed
 * art. A launcher crops a maskable icon to a safe-zone circle of 80% diameter,
 * and the badge is wider than it is tall, so declaring it maskable cost it both
 * ends of the wordmark and the wifi arcs. The -maskable files carry the inset
 * already, on an opaque ground -- a transparent maskable gets whatever the
 * launcher paints behind it.
 */
app.get('/manifest.webmanifest', (c) =>
  c.json({
    name: 'TipoffWatch',
    short_name: 'Tipoff',
    description: 'Follow any team in the world and get told before they play.',
    start_url: '/following',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#12161f',
    theme_color: '#12161f',
    icons: [
      ...[48, 128, 192, 256, 384, 512].map((s) => ({
        src: assetUrl(`icons/icon-${s}x${s}.png`),
        sizes: `${s}x${s}`,
        type: 'image/png',
        purpose: 'any',
      })),
      ...[192, 512].map((s) => ({
        src: assetUrl(`icons/icon-${s}x${s}-maskable.png`),
        sizes: `${s}x${s}`,
        type: 'image/png',
        purpose: 'maskable',
      })),
    ],
  }),
);

/*
 * `Allow: /` with nothing excluded, which is what this said, is an invitation to
 * crawl the sign-in page -- and one SEO bot took it, fetching /login about once a
 * second, forty-seven percent of all traffic to the site. It was not doing
 * anything wrong; nobody had told it not to.
 *
 * None of these paths should ever be crawled or indexed. They are the same page
 * for every signed-out visitor, they carry nothing a search result should point
 * at, and /api/ answers callers rather than readers.
 */
app.get('/robots.txt', (c) => {
  c.header('cache-control', 'public, max-age=3600');
  return c.text(robotsTxt());
});

/*
 * The three files written for machines.
 *
 * llms.txt is a map of the site for a model with one request to spend; skill.md
 * says what an agent can call rather than read; security.txt gives a researcher
 * somewhere to send a report. All three were 404s, which for a site whose whole
 * value is machine-readable schedule data was the wrong answer.
 *
 * Served from routes rather than public/ because they name the brand, the live
 * catalogue counts and the site's own origin -- a static file would describe
 * whichever site was checked in.
 */
app.get('/llms.txt', async (c) => {
  // The counts are the same ones /about shows, and they are cheap and cached.
  const stats = await q.catalogueStats().catch(() => ({}));
  c.header('content-type', 'text/plain; charset=utf-8');
  c.header('cache-control', 'public, max-age=3600');
  return c.body(llmsTxt(stats));
});

app.get('/skill.md', (c) => {
  c.header('content-type', 'text/markdown; charset=utf-8');
  c.header('cache-control', 'public, max-age=3600');
  return c.body(skillMd());
});

app.get('/.well-known/security.txt', (c) => {
  c.header('content-type', 'text/plain; charset=utf-8');
  return c.body(securityTxt());
});

const STATIC_FILES = [
  ['/styles.css', 'styles.css', 'text/css'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/push-check.js', 'push-check.js', 'text/javascript'],
  ['/vendor-webauthn.js', 'vendor-webauthn.js', 'text/javascript'],
  // Fetched by app.js on the first press of Play, not linked by the Layout: it is
  // a quarter of a megabyte of demuxer that most readers never need.
  ['/vendor-mpegts.js', 'vendor-mpegts.js', 'text/javascript'],
  // Same again for the radio player and its stylesheet: fetched on the first
  // press of Play on a station, by app.js.
  ['/vendor-player.js', 'vendor-player.js', 'text/javascript'],
  ['/vendor-player.css', 'vendor-player.css', 'text/css'],
  ['/sw.js', 'sw.js', 'text/javascript'],
  ['/logo.png', 'logo.png', 'image/png'],
];

/**
 * The icons the markup and the manifest link, hashed alongside the other assets.
 *
 * They are cached for a week, so redrawing one under its own name -- which is
 * what fixing an icon means -- reaches nobody who has visited recently. The
 * install prompt in particular reads the manifest and keeps whatever it got.
 */
const VERSIONED_ICONS = [
  'icons/favicon-16.png',
  'icons/favicon-32.png',
  ...[76, 120, 144, 152, 180].map((s) => `icons/apple-touch-icon-${s}x${s}.png`),
  ...[48, 128, 192, 256, 384, 512].map((s) => `icons/icon-${s}x${s}.png`),
  ...[192, 512].map((s) => `icons/icon-${s}x${s}-maskable.png`),
];

// Hashed once at boot so pages can link /styles.css?v=<hash>. See lib/asset-version.js.
await loadAssetVersions([...STATIC_FILES.map(([, file]) => file), ...VERSIONED_ICONS]);

for (const [route, file, type] of STATIC_FILES) {
  app.get(route, async (c) => {
    const f = Bun.file(new URL(`../public/${file}`, import.meta.url).pathname);
    c.header('content-type', type);
    if (file === 'sw.js') {
      // The service worker must never be served stale or a bad version pins itself.
      c.header('cache-control', 'no-cache');
    } else if (isCurrentVersion(file, c.req.query('v'))) {
      // The URL carries the content hash, so these bytes can never change under
      // it — a new build is a new URL. Safe to cache hard.
      c.header('cache-control', 'public, max-age=31536000, immutable');
    } else {
      // An unversioned (or stale-versioned) request: someone's cached HTML, or a
      // direct hit. Keep it short so they pick up the next deploy quickly.
      c.header('cache-control', 'public, max-age=60, must-revalidate');
    }
    return c.body(await f.arrayBuffer());
  });
}

/**
 * The generated icon set.
 *
 * A directory route rather than seventeen literal ones. The filename is matched
 * against a strict pattern instead of being joined onto a path: `/icons/..%2f..`
 * would otherwise walk out of public/ and serve anything the process can read.
 */
const ICON_TYPES = { png: 'image/png', ico: 'image/x-icon', xml: 'application/xml' };

app.get('/icons/:file', async (c) => {
  const file = c.req.param('file');
  if (!/^[a-z0-9][a-z0-9._-]*\.(png|ico|xml)$/i.test(file) || file.includes('..')) {
    return c.notFound();
  }
  const f = Bun.file(new URL(`../public/icons/${file}`, import.meta.url).pathname);
  if (!(await f.exists())) return c.notFound();
  c.header(
    'content-type',
    ICON_TYPES[file.split('.').pop().toLowerCase()] ?? 'application/octet-stream',
  );
  if (isCurrentVersion(`icons/${file}`, c.req.query('v'))) {
    // The URL carries the content hash, so these bytes cannot change under it.
    c.header('cache-control', 'public, max-age=31536000, immutable');
  } else {
    // Unversioned: a bare /icons/... hit, or cached markup pointing at an older
    // hash. Kept short so a redrawn icon is not pinned for a week.
    c.header('cache-control', 'public, max-age=3600, must-revalidate');
  }
  return c.body(await f.arrayBuffer());
});

/** Browsers request this at the root regardless of what the markup declares. */
app.get('/favicon.ico', async (c) => {
  const f = Bun.file(new URL('../public/icons/favicon.ico', import.meta.url).pathname);
  c.header('content-type', 'image/x-icon');
  c.header('cache-control', 'public, max-age=604800');
  return c.body(await f.arrayBuffer());
});

/*
 * The last stop for a path this app does not have, and the only place a scanner
 * can be counted.
 *
 * Mostly what lands here asked for a path this app has never had, which readers
 * do rarely and scanners do hundreds of times in a row. The pages that answer a
 * reader's dead link -- an event that has been and gone, a profile that is
 * private -- render `<NotFound>` inside their own route and never reach this
 * handler, so a person following a stale link out of somebody's timeline is not
 * metered at all.
 *
 * The exception is the thirteen machine-facing routes that answer with a bare
 * `c.notFound()`: a calendar or RSS subscription to an event that no longer
 * exists, or an icon hash from a cached page. Those DO land here and are
 * counted, and that is acceptable precisely because of the next paragraph -- a
 * calendar client polling a dead feed hourly would need a day to reach the
 * allowance, and all it would get for it is a 429 where it was already getting
 * a 404.
 *
 * The refusal is deliberately confined to the miss itself. A locked caller is
 * still served normally by every route that exists, because the counter only
 * ever runs on this handler -- so the worst a false positive can do is answer
 * 429 instead of 404 to somebody who was going to get nothing either way. That
 * is the whole reason this can be turned on at all: unlike the auth curves,
 * this one cannot lock anybody out of anything real.
 */
app.notFound(async (c) => {
  const caller = callerAddress(c);
  if (caller) {
    const verdict = attempt(`miss:${caller}`, Date.now(), MISS);
    if (!verdict.ok) {
      console.warn(
        `[auth] miss backoff: ${caller} strike ${verdict.strikes}, ${verdict.retryAfter}s`,
      );
      c.header('retry-after', String(verdict.retryAfter));
      // A 429 that got cached would outlive the lock it was reporting.
      c.header('cache-control', 'no-store');
      // Text, not the rendered page: refusing has to be cheaper than answering,
      // or a limiter on a flood is just a slower way to serve the flood.
      return c.text(`Too many requests. Try again in ${waitFor(verdict.retryAfter)}.`, 429);
    }
  }
  return c.html(await render(<NotFound user={c.get('user')} />), 404);
});
