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

  databaseUrl: req('DATABASE_URL', 'postgres://localhost:5432/tipoffwatch'),
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
    /** How far ahead to keep the calendar populated. */
    horizonDays: num('SPORTS_HORIZON_DAYS', 14),
    syncConcurrency: num('SPORTS_SYNC_CONCURRENCY', 6),
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
    apiKey: opt('COINPAY_API_KEY'),
    businessId: opt('COINPAY_BUSINESS_ID'),
    webhookSecret: opt('COINPAY_WEBHOOK_SECRET'),
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
