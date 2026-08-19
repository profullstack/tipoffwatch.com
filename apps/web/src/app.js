import * as auth from '@tipoff/auth';
import { config } from '@tipoff/config';
import * as q from '@tipoff/db/queries';
import { sendLoginLink } from '@tipoff/notify';
import * as pay from '@tipoff/payments';
import { connection } from '@tipoff/queue';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  About,
  EventPage,
  Following,
  Landing,
  LeaguePage,
  NotFound,
  Settings,
  SignIn,
  SportPage,
  SportsIndex,
} from './views/pages.jsx';

export const app = new Hono();

/* ----------------------------------------------------------------- helpers -- */

/**
 * Answer the caller in its own language.
 *
 * Every control on the site is a plain form, so the browser gets a 303 back to
 * where it came from and the page works with JavaScript off. A caller that asked
 * for JSON gets JSON. One helper, so the two can never drift apart.
 */
function respond(c, { json, redirectTo }) {
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('application/json') || c.req.header('x-requested-with') === 'fetch') {
    return c.json(json ?? { ok: true });
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

app.use('*', async (c, next) => {
  const sid = getCookie(c, config.session.cookie);
  c.set('user', sid ? await auth.userFromRequest(sid) : null);
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

const tzOf = (c) => c.get('user')?.timezone ?? 'UTC';

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
  if (!config.cache.enabled || c.get('user')) return c.html(await produce());

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

app.get('/', async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  return cached(c, `page:home:${today}`, config.cache.scheduleTtlSeconds, async () => {
    const events = await q.scheduleForDay({ day: today, limit: 40 });
    return render(
      <Landing user={c.get('user')} today={events} tz={tzOf(c)} vapidKey={config.push.publicKey} />,
    );
  });
});

app.get('/sports', async (c) =>
  cached(c, 'page:sports', 300, async () => {
    const [sports, leagues] = await Promise.all([q.listSports(), q.listLeagues({ limit: 30 })]);
    return render(<SportsIndex user={c.get('user')} sports={sports} leagues={leagues} />);
  }),
);

app.get('/sports/:sport', async (c) => {
  const sport = c.req.param('sport');
  const leagues = await q.listLeagues({ sport, limit: 500 });
  if (leagues.length === 0) return c.html(await render(<NotFound user={c.get('user')} />), 404);
  return c.html(await render(<SportPage user={c.get('user')} sport={sport} leagues={leagues} />));
});

app.get('/leagues/:slug', async (c) => {
  const slug = c.req.param('slug');
  const league = await q.getLeagueBySlug(slug);
  if (!league) return c.html(await render(<NotFound user={c.get('user')} />), 404);
  return cached(c, `page:league:${slug}`, config.cache.scheduleTtlSeconds, async () => {
    const events = await q.upcomingForLeague(league.id);
    return render(<LeaguePage user={c.get('user')} league={league} events={events} tz={tzOf(c)} />);
  });
});

app.get('/following', async (c) => {
  const user = requireUser(c);
  const [events, follows] = await Promise.all([q.upcomingForUser(user.id), q.listFollows(user.id)]);
  return c.html(
    await render(
      <Following
        user={user}
        events={events}
        follows={follows}
        tz={user.timezone}
        vapidKey={config.push.publicKey}
      />,
    ),
  );
});

app.get('/events/:id', async (c) => {
  const user = c.get('user');
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.html(await render(<NotFound user={user} />), 404);
  const [offers, entitlement] = await Promise.all([
    pay.offersForEvent(event.id),
    user ? pay.activeEntitlement({ userId: user.id, eventId: event.id }) : null,
  ]);
  return c.html(
    await render(
      <EventPage
        user={user}
        event={event}
        tz={tzOf(c)}
        offers={offers}
        entitlement={entitlement}
      />,
    ),
  );
});

/* -------------------------------------------------------------------- auth -- */

app.get('/login', async (c) =>
  c.html(await render(<SignIn mode="login" next={c.req.query('next')} />)),
);
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

app.get('/auth/magic', async (c) => {
  const token = c.req.query('t');
  if (!token) return c.redirect('/login', 303);
  const result = await auth.consumeLoginLink(token, { userAgent: c.req.header('user-agent') });
  if (!result) return c.html(await render(<SignIn mode="login" next="/following" />), 400);
  c.header('set-cookie', auth.sessionCookie(result.sessionId));
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

app.post('/api/auth/passkey/authenticate/options', async (c) => {
  const options = await auth.passkeyAuthenticationOptions();
  await stashChallenge(c, options.challenge);
  return c.json(options);
});

app.post('/api/auth/passkey/authenticate/verify', async (c) => {
  const expectedChallenge = await takeChallenge(c);
  if (!expectedChallenge) return c.json({ error: 'challenge expired' }, 400);
  const result = await auth.verifyPasskeyAuthentication({
    response: await c.req.json(),
    expectedChallenge,
    userAgent: c.req.header('user-agent'),
  });
  if (!result) return c.json({ error: 'rejected' }, 400);
  c.header('set-cookie', auth.sessionCookie(result.sessionId));
  return c.json({ ok: true });
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

app.get('/settings', async (c) => {
  const user = requireUser(c);
  const [prefs, passkeys] = await Promise.all([q.getPrefs(user.id), q.listPasskeys(user.id)]);
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
      />,
    ),
  );
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

/* ---------------------------------------------------------------- payments -- */

app.post('/api/events/:id/buy', async (c) => {
  const user = requireUser(c);
  const event = await q.getEvent(Number(c.req.param('id')));
  if (!event) return c.json({ error: 'no such event' }, 404);

  const body = await c.req.parseBody();
  const [offer] = (await pay.offersForEvent(event.id)).filter(
    (o) => o.id === Number(body.offer_id),
  );
  if (!offer) return c.json({ error: 'offer unavailable' }, 409);

  const checkoutUrl = await pay.createCheckout({ user, event, offer });
  return respond(c, { json: { checkoutUrl }, redirectTo: checkoutUrl });
});

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

  const result = await pay.grantFromWebhook(JSON.parse(raw));
  return c.json(result);
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
    name: 'TipoffWatch API',
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

app.get('/about', async (c) => {
  const stats = await q.catalogueStats();
  return c.html(await render(<About user={c.get('user')} stats={stats} />));
});

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
  const paths = ['/', '/sports', '/about', '/login', '/signup'];
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

app.get('/sitemaps/leagues.xml', async (c) => {
  const leagues = await q.listLeagues({ limit: 1000 });
  c.header('content-type', 'application/xml');
  return c.body(
    `${xmlHeader}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${leagues
      .map(
        (l) =>
          `<url><loc>${config.siteUrl}/leagues/${l.slug}</loc><changefreq>daily</changefreq></url>`,
      )
      .join('')}</urlset>`,
  );
});

app.get('/sitemaps/events-:month{[0-9]{4}-[0-9]{2}}.xml', async (c) => {
  const events = await q.eventsForMonth(c.req.param('month'));
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

app.get('/manifest.webmanifest', (c) =>
  c.json({
    name: 'TipoffWatch',
    short_name: 'Tipoff',
    start_url: '/following',
    display: 'standalone',
    background_color: '#0b0f17',
    theme_color: '#0b0f17',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  }),
);

app.get('/robots.txt', (c) =>
  c.text(`User-agent: *\nAllow: /\nSitemap: ${config.siteUrl}/sitemap.xml\n`),
);

for (const [route, file, type] of [
  ['/styles.css', 'styles.css', 'text/css'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/vendor-webauthn.js', 'vendor-webauthn.js', 'text/javascript'],
  ['/sw.js', 'sw.js', 'text/javascript'],
  ['/icon.svg', 'icon.svg', 'image/svg+xml'],
]) {
  app.get(route, async (c) => {
    const f = Bun.file(new URL(`../public/${file}`, import.meta.url).pathname);
    c.header('content-type', type);
    // The service worker must never be served stale or a bad version pins itself.
    c.header('cache-control', file === 'sw.js' ? 'no-cache' : 'public, max-age=3600');
    return c.body(await f.arrayBuffer());
  });
}

app.notFound(async (c) => c.html(await render(<NotFound user={c.get('user')} />), 404));
