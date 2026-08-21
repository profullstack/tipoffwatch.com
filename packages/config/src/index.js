/**
 * One place that reads the environment, so no other module ever touches process.env.
 *
 * Everything is read once at import. A missing *required* variable throws here, at boot,
 * rather than at the moment a customer clicks something -- which is the failure mode we
 * keep hitting when secrets live in scattered `process.env.X ?? fallback` reads.
 */

/** @param {string} name @param {string} [fallback] */
function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var ${name}`);
  return v;
}

/** @param {string} name @param {string} [fallback] */
const opt = (name, fallback = '') => process.env[name] ?? fallback;

/** @param {string} name @param {number} fallback */
const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got ${raw}`);
  return n;
};

/** @param {string} name @param {boolean} fallback */
const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

export const config = {
  env: opt('NODE_ENV', 'development'),
  isProd: opt('NODE_ENV', 'development') === 'production',

  /** Railway injects PORT. Never hardcode it -- a fixed port makes every request 404
   *  behind the edge proxy while the container still reports healthy. */
  port: num('PORT', 3000),

  /** Public origin. Passkey rpID is derived from this, so changing it invalidates
   *  every credential already registered. */
  siteUrl: opt('SITE_URL', 'http://localhost:3000').replace(/\/$/, ''),

  /**
   * No fallback, deliberately.
   *
   * Giving `req` a default defeats the only thing it does. A service deployed
   * without DATABASE_URL then silently dialled localhost and died several seconds
   * later with `ERR_POSTGRES_CONNECTION_CLOSED` — a Postgres error that says
   * nothing about the actual problem, which is a missing variable. Failing here
   * names it.
   */
  databaseUrl: req('DATABASE_URL'),

  /** Redis genuinely is optional: without it the cache degrades to hitting Postgres. */
  redisUrl: opt('REDIS_URL', 'redis://localhost:6379'),

  /** Which roles this process runs. One Railway service runs "web,worker"; splitting
   *  them later is a variable change, not a code change. */
  roles: opt('ROLES', 'web,worker')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  sports: {
    /** Comma-separated adapter names, tried in order. ESPN is free and keyless. */
    providers: opt('SPORTS_PROVIDERS', 'espn')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    apiSportsKey: opt('API_SPORTS_KEY'),
    /**
     * TheSportsDB, used for one thing: TV listings ESPN does not carry.
     *
     * "3" is the shared test key and works without an account, which is why it is
     * the default -- the fallback pass should do something useful on a fresh
     * checkout rather than nothing. It is capped at ONE ROW per query, so on this
     * key the pass fills a handful of fixtures a day. A subscriber key removes the
     * cap and is the only change needed; see packages/sports/src/sportsdb.js.
     */
    sportsDbKey: opt('SPORTSDB_API_KEY', '3'),
    /**
     * Residential proxy, used only when the provider blocks us directly.
     *
     * ESPN blocks datacenter egress: the same request that works from a laptop
     * returns 403 Access Denied from Railway. Residential bandwidth is metered, so
     * this is a fallback rather than the default route -- see packages/sports.
     */
    proxyUrl: opt('SPORTS_PROXY_URL'),
    /** How far ahead to keep the calendar populated. */
    horizonDays: num('SPORTS_HORIZON_DAYS', 14),
    syncConcurrency: num('SPORTS_SYNC_CONCURRENCY', 6),
    /**
     * How far back a finished game is still owed its one closing read.
     *
     * A game gets its play log while it is on, plus one read after the whistle for
     * whatever landed in between. This is the cutoff on that second read, and it
     * exists to bound cost rather than to express a rule: every summary is ~500KB
     * through the metered proxy, so an unbounded window would pull a season of them
     * the first time it ran.
     *
     * Twelve hours covers any fixture played since the last poll. Widen it to
     * backfill history -- 168 for a week -- and put it back afterwards, the same
     * on/deploy/off shape as SYNC_ON_BOOT. The poller still reads only 8 summaries
     * per tick, so a wide window costs time and bandwidth, not a spike: reckon
     * ~4 fixtures a minute and ~500KB each.
     */
    playsCatchupHours: num('SPORTS_PLAYS_CATCHUP_HOURS', 12),
    /**
     * How far BACK the fixture sweep asks the provider for, in days.
     *
     * The sweep's job is the calendar, so it only ever looked forward: `from` was
     * six hours ago, enough to close out whatever was in progress at the last pass.
     * That is also why widening SPORTS_PLAYS_CATCHUP_HOURS on its own backfills
     * nothing. The catch-up window decides which STORED fixtures are still owed a
     * play log; it cannot reach a game that was never written down, and at a
     * six-hour `from` no game older than this morning ever was. Setting the window
     * to 336 changed the backlog by zero rows, which is the symptom.
     *
     * So: this reaches back for the fixtures themselves, and the catch-up window
     * then reaches them. Both are needed, in that order.
     *
     * Zero by default, which is exactly the old behaviour -- the six-hour floor
     * below still applies, so this can only ever widen the window. Turning it on is
     * not free in either direction: the provider caps a response near 100 events
     * and the adapter splits and refetches, so a 14-day reach costs extra upstream
     * requests on a busy league; and every finished fixture it stores then becomes
     * eligible for a ~500KB summary read through the metered proxy. Same
     * on/deploy/off shape as SYNC_ON_BOOT -- set it, let one sweep run, put it back.
     */
    backfillDays: num('SPORTS_BACKFILL_DAYS', 0),
  },

  push: {
    publicKey: opt('VAPID_PUBLIC_KEY'),
    privateKey: opt('VAPID_PRIVATE_KEY'),
    subject: opt('VAPID_SUBJECT', 'mailto:hello@tipoffwatch.com'),
    get enabled() {
      return Boolean(this.publicKey && this.privateKey);
    },
  },

  mail: {
    resendKey: opt('RESEND_API_KEY'),
    from: opt('MAIL_FROM', 'TipoffWatch <alerts@tipoffwatch.com>'),
    get enabled() {
      return Boolean(this.resendKey);
    },
  },

  coinpay: {
    /** Must be a MERCHANT api key (cp_live_/cp_test_ + 32 hex). An OAuth client id
     *  (cp_ + 24 hex) authenticates but cannot create payments -- it fails only at
     *  checkout, which is why this is asserted at boot rather than trusted. */
    /* Read on use rather than snapshotted at import. These three are only ever
       touched inside a request, and snapshotting them made the value depend on which
       module imported config first -- which turned the webhook signature tests into a
       coin flip decided by the rest of the suite. */
    get apiKey() {
      return opt('COINPAY_API_KEY');
    },
    get businessId() {
      return opt('COINPAY_BUSINESS_ID');
    },
    get webhookSecret() {
      return opt('COINPAY_WEBHOOK_SECRET');
    },
    baseUrl: opt('COINPAY_BASE_URL', 'https://coinpayportal.com'),
    get enabled() {
      return Boolean(this.apiKey && this.businessId && this.webhookSecret);
    },
  },

  reminders: {
    /** Minutes before kickoff. The product promises 60 and 1. */
    defaultOffsets: opt('REMINDER_OFFSETS', '60,1')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    /** Subscribers pulled per fan-out page. Queue depth stays proportional to
     *  batches, not to followers -- see packages/queue. */
    batchSize: num('REMINDER_BATCH_SIZE', 500),
    /** A reminder later than this past its due moment is dropped, not sent late.
     *  Telling someone a game starts in an hour 40 minutes after kickoff is worse
     *  than saying nothing. */
    maxLatenessSeconds: num('REMINDER_MAX_LATENESS_SECONDS', 300),
  },

  sync: {
    /** Hours before the fixture sweep counts as overdue at boot. */
    staleHours: num('SYNC_STALE_HOURS', 6),
    /**
     * Sweep on the next boot whatever the clock says.
     *
     * The escape hatch for the case the staleness check cannot cover: code that
     * reads a NEW field from the provider ships, every league was swept an hour
     * ago, and so nothing is due for another five -- during which the new column
     * is null everywhere and the feature looks broken. Turn it on, deploy, turn it
     * off. Left on, it sweeps once per boot, which is ~354 upstream requests.
     */
    onBoot: bool('SYNC_ON_BOOT', false),
  },

  cache: {
    /** Schedule pages are identical for every visitor, so they are rendered once and
     *  served from Redis. Personalisation is layered client-side. */
    scheduleTtlSeconds: num('CACHE_SCHEDULE_TTL', 60),
    enabled: bool('CACHE_ENABLED', true),
  },

  session: {
    cookie: 'tw_session',
    ttlDays: num('SESSION_TTL_DAYS', 90),
  },
};

/** Asserted at boot by whichever process is about to depend on it. */
export function assertCoinpayMerchantKey() {
  const k = config.coinpay.apiKey;
  if (!k) return;
  const merchant = /^cp_(live|test)_[0-9a-f]{32}$/.test(k);
  if (!merchant) {
    throw new Error(
      'COINPAY_API_KEY is not a merchant API key. Expected cp_live_/cp_test_ + 32 hex. ' +
        'An OAuth client id (cp_ + 24 hex) grants identity only and cannot create payments.',
    );
  }
}
