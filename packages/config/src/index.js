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

export { brand, brands, href, Word } from './brands.js';

import { brand } from './brands.js';

export const config = {
  /** Which site this process is serving. See packages/config/src/brands.js. */
  brand,

  env: opt('NODE_ENV', 'development'),
  isProd: opt('NODE_ENV', 'development') === 'production',

  /** Railway injects PORT. Never hardcode it -- a fixed port makes every request 404
   *  behind the edge proxy while the container still reports healthy. */
  port: num('PORT', 3000),

  /** Public origin. Passkey rpID is derived from this, so changing it invalidates
   *  every credential already registered. */
  siteUrl: opt('SITE_URL', 'http://localhost:3000').replace(/\/$/, ''),

  /**
   * Where a reader writes to, and where a security researcher reports to.
   *
   * NO default, on purpose. Inventing `hello@<domain>` and publishing it in the
   * footer, in security.txt and in the Organization markup would put an address
   * nobody reads in front of everyone who has something to say -- which is worse
   * than saying nothing, because it looks like a working contact. Unset, the
   * contact page says how to reach us another way and the markup omits the field.
   */
  contactEmail: opt('CONTACT_EMAIL') || null,

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
     * Live Tennis API, which owns tennis outright when it is in SPORTS_PROVIDERS.
     *
     * Everything here exists to fit inside a request quota. The free key allows
     * **100 requests a day**, which is less than the 60-second live tick would
     * spend before lunch, so the adapter shares one snapshot across every tour and
     * refuses to refresh it more often than the TTLs below. The defaults spend
     * roughly 60 requests a day: 48 live refreshes at half-hourly, plus a fixture
     * and a results read every six hours.
     *
     * The tiers, so the knobs can be turned with the numbers in view:
     *
     *   Free    30/min      100/day    live TTL 1800 (the defaults here)
     *   Basic   60/min      1k/day     live TTL 120 -- $9.99/mo, adds match history
     *   Pro     300/min     10k/day    live TTL 60  -- adds odds and timelines
     *   Ultra   600/min     500k/day   adds WebSocket push, so no polling at all
     *
     * On a paid key set LIVETENNIS_DAILY_BUDGET to the tier's daily allowance less
     * a small margin, and LIVETENNIS_LIVE_TTL_SECONDS to the cadence you actually
     * want. Nothing else changes.
     */
    livetennis: {
      apiKey: opt('LIVETENNIS_API_KEY'),
      /**
       * How stale a live score may be before the provider is asked again.
       *
       * This is the one number a reader feels. Half an hour is the free tier's
       * honest answer -- 48 refreshes a day is already half the whole allowance --
       * and it is why the live tick running every 60 seconds does not mean tennis
       * scores update every 60 seconds. Two minutes is affordable on Basic.
       */
      liveTtlSeconds: num('LIVETENNIS_LIVE_TTL_SECONDS', 1800),
      /**
       * How often the fixture list and the just-finished list are re-read.
       *
       * Far less urgent than the scores: a tennis draw is published a day or two
       * ahead and does not churn, so six hours costs eight requests a day and
       * never leaves a fixture unwritten inside the horizon.
       */
      fixturesTtlSeconds: num('LIVETENNIS_FIXTURES_TTL_SECONDS', 21600),
      /**
       * A hard ceiling on requests per UTC day, counted the way the provider does.
       *
       * The TTLs above are the plan; this is what happens when the plan is wrong --
       * a redeploy loop, a backfill, a retry storm. At the ceiling the adapter
       * stops spending and serves the last snapshot it holds rather than throwing,
       * because a score half an hour old beats an empty league page and a 429 is
       * worth less than both. Ninety-five leaves five for a manual poke.
       */
      dailyBudget: num('LIVETENNIS_DAILY_BUDGET', 95),
      /**
       * The point-by-point log, which is metered separately and deliberately.
       *
       * `/history/matches/{id}` returns a match's whole tape -- every point, with
       * the server and the running score -- and it answers for a match that is
       * still being played. It is the play-by-play tennis was missing.
       *
       * It also costs ONE REQUEST PER MATCH, against a budget that buys 100 a day
       * for everything. There were 14 tennis matches in progress at once on an
       * ordinary Saturday; taping all of them once is a seventh of the day's
       * allowance. So the tape gets a sub-budget of its own and cannot touch the
       * scores': a log is worth having, and not at the price of the scoreboard
       * that every fixture depends on.
       *
       * What this buys, and what it does not: the tape is COMPLETE up to the
       * moment it is read, so one request gives the entire match so far rather
       * than a slice. A log therefore lags by up to `tapeMinIntervalSeconds` while
       * a match is on, and is complete and permanent once it ends. On this budget
       * that is the honest trade -- a complete record slightly late, rather than a
       * live ticker that cannot be afforded.
       */
      tapeBudget: num('LIVETENNIS_TAPE_BUDGET', 30),
      /**
       * Which tours get a log at all.
       *
       * ITF is most of the calendar by volume -- 16 of the 14-match sample -- and
       * least of the interest, so taping it would spend the whole allowance on
       * matches nobody opened. Widen this the moment the budget does.
       */
      tapeTours: opt('LIVETENNIS_TAPE_TOURS', 'atp,wta')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      /**
       * How long before the same match may be re-taped.
       *
       * The plays rail asks every two minutes, which at one request per match
       * would empty the day's budget in an hour. Twenty minutes is the cooldown
       * that makes the sub-budget above last a day across a handful of matches.
       */
      tapeMinIntervalSeconds: num('LIVETENNIS_TAPE_MIN_INTERVAL_SECONDS', 1200),
    },
    /**
     * Residential proxy, used only when the provider blocks us directly.
     *
     * ESPN blocks datacenter egress: the same request that works from a laptop
     * returns 403 Access Denied from Railway. Residential bandwidth is metered, so
     * this is a fallback rather than the default route -- see packages/sports.
     */
    /*
     * A getter, not a snapshot, for the same reason the CoinPay block is one: the
     * comment above calls this "the lever", and a value read once at import is not
     * a lever -- it cannot be changed without a restart, and it cannot be exercised
     * by a test at all, because whichever module imported config first decides it
     * for the whole process.
     */
    get proxyUrl() {
      return opt('SPORTS_PROXY_URL');
    },
    /** How far ahead to keep the calendar populated. */
    horizonDays: num('SPORTS_HORIZON_DAYS', 14),
    /**
     * How far ahead the frequent refresh reaches, in hours.
     *
     * The full sweep runs daily; this window is what gets re-read every few hours,
     * scoped to the leagues that actually have a game inside it. 48 hours covers
     * tonight and tomorrow, which measured at 74 of 359 leagues -- a fifth of a
     * sweep. Widening it costs roughly linearly in leagues, not in days.
     */
    nearWindowHours: num('SPORTS_NEAR_WINDOW_HOURS', 48),
    /**
     * How far ahead the category page's "starting soon" list reaches, in hours.
     *
     * Nothing to do with syncing: this is purely how much of the front of the
     * calendar that page shows. Four hours is roughly "the rest of an evening" --
     * long enough to be worth checking before you settle down, short enough that
     * the list is still a list rather than a schedule. A knob rather than a
     * constant because the right answer differs by brand: a release calendar's
     * useful window is not a fixture list's.
     */
    soonWindowHours: num('SPORTS_SOON_WINDOW_HOURS', 4),
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

  /**
   * A reader's own channel list.
   *
   * Strictly personal: one list per account, never pooled, never shown to anyone
   * else, and never wired to the resale offers. The playlist URL carries the
   * reader's provider credentials in its path, so it is encrypted at rest -- and
   * without a secret to encrypt it with, the feature turns itself off rather than
   * storing credentials in the clear.
   */
  playlists: {
    /**
     * The key the stored playlist URL is encrypted with.
     *
     * PLAYLIST_SECRET when it is set, and otherwise derived from DATABASE_URL --
     * which works because DATABASE_URL is required, so there is always a key, and
     * because it is NOT stored in the database it protects. That is the whole
     * point of encrypting these: the threat is a copy of the database (a backup, a
     * dump pulled to a laptop), and a dump contains the sealed rows but not the
     * environment that can open them.
     *
     * The trade for that convenience: rotating the database credentials makes
     * stored lists unreadable, and every reader simply adds theirs again --
     * decryption returns null rather than garbage, so nothing breaks loudly. Set
     * PLAYLIST_SECRET explicitly to decouple the two.
     */
    get secret() {
      return opt('PLAYLIST_SECRET') || opt('DATABASE_URL');
    },
    /** Always on: there is no configuration left to forget. */
    get enabled() {
      return Boolean(this.secret);
    },
    /** Refuse a list bigger than this, in bytes. A real provider list is ~800KB. */
    /**
     * Refuse a list bigger than this, in bytes.
     *
     * 100MB, raised from 8MB after a real 38MB list was rejected with "that list
     * is larger than we store". Eight megabytes was sized for a channel lineup --
     * a few thousand rows of title and URL. A provider that also exposes its VOD
     * library ships its whole catalogue in the same file, and those run to
     * hundreds of thousands of entries.
     *
     * The ceiling is still a ceiling: this is read into memory as one string
     * before it is parsed, so it bounds what a wrong URL pointing at something
     * enormous can cost.
     */
    maxBytes: num('PLAYLIST_MAX_BYTES', 100 * 1024 * 1024),

    /**
     * Hard ceiling on entries stored from one list.
     *
     * Was a constant of 20,000 in the parser, which silently truncated: a reader
     * importing a 300,000-entry catalogue got 20,000 rows, no error, and no way to
     * tell which 280,000 were missing. It is a knob now, the import reports when it
     * hits it, and the default is high enough for a full VOD catalogue.
     */
    maxChannels: num('PLAYLIST_MAX_CHANNELS', 300_000),

    /**
     * How often each list is re-fetched, in minutes.
     *
     * Five, because the provider rewrites its numbered event slots close to
     * kickoff and a stale title is a missed match. Know what it costs before
     * lowering it further: this provider supports no conditional request at all
     * (measured 2026-08-21 -- no ETag, no Last-Modified, If-Modified-Since
     * answered with a full 200), so every poll downloads the whole file. At five
     * minutes that is 288 fetches and roughly 230MB a day PER LIST, pulled from
     * the reader's own subscription by a datacenter IP. Content hashing spares the
     * database but cannot spare the download.
     *
     * Raise it if a provider starts objecting; that is the lever, and it needs no
     * deploy.
     */
    refreshMinutes: num('PLAYLIST_REFRESH_MINUTES', 5),

    /**
     * Bytes per minute of refresh interval, for lists too big to poll every five.
     *
     * The provider offers no conditional request, so every poll downloads the
     * whole file. At five minutes that is 288 fetches a day: fine for an 8MB
     * lineup (~2GB/day, already a lot) and indefensible for a 38MB catalogue,
     * which would pull 11GB a day off the reader's own subscription from a
     * datacenter IP. That is how a line gets flagged.
     *
     * So a big list is polled proportionally less often: interval scales with
     * size, floored at refreshMinutes. 2MB per minute puts a 38MB list on a
     * ~19-minute cycle and leaves an ordinary lineup untouched.
     */
    refreshBytesPerMinute: num('PLAYLIST_REFRESH_BYTES_PER_MINUTE', 2 * 1024 * 1024),

    /**
     * Playing a channel in the page itself, rather than handing it to an app.
     *
     * On by default, because the devices that most need it are the ones with no
     * app to hand it to: a Fire TV, an Android TV, a desktop browser at work. It
     * has a switch anyway, and the switch is about MONEY rather than correctness
     * -- this is the only route on the site where a request costs bandwidth by
     * the gigabyte. A single 1080p channel runs 4-6 Mbps, so one viewer watching
     * one match moves roughly 2.5GB, and it is billed twice: in from the provider
     * and out to the reader. Everything else here is a byte pipe by design
     * precisely so that this is the only cost it can have.
     *
     * Set STREAM_PROXY=0 to take it away without a deploy; the VLC, Infuse and
     * .m3u buttons keep working, because they never went through us.
     */
    proxy: {
      get enabled() {
        return opt('STREAM_PROXY', '1') !== '0';
      },
      /**
       * Concurrent in-page streams per account.
       *
       * One, matching what a typical line permits. This exists to protect the
       * READER's subscription, not our capacity -- a provider that sees two
       * simultaneous connections from one credential suspends the account.
       *
       * At the ceiling the OLDEST stream is dropped, not the newest: pressing
       * Play on another channel says which channel is wanted now, so it takes the
       * line over. Raising this above 1 only makes sense for a line that really
       * permits more; it does not make the player better behaved.
       */
      maxPerUser: num('STREAM_PROXY_MAX_PER_USER', 1),
    },
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

  /**
   * Selling access to something, through CoinPay.
   *
   * Shared verbatim with the sibling brand -- @tipoff/payments and @genre/payments
   * are the same file -- so this block is deliberately identical in both configs
   * too. A difference here would be a difference the shared package cannot see.
   */
  payments: {
    /**
     * How long access outlives the thing it was bought for, in hours.
     *
     * There is no perpetual licence to a stream, and an open-ended grant is what
     * turns a small sale into redistribution. The grace exists because a fixture
     * running to extra time, or a premiere starting late, must not cut a paying
     * viewer off mid-way.
     */
    entitlementGraceHours: num('ENTITLEMENT_GRACE_HOURS', 6),

    /**
     * An address to forward the net to INSTEAD of this business's own wallet.
     *
     * Almost always empty, and that is correct. The payee belongs on the business
     * -- import the account-global wallets once and the upstream resolves the
     * right address per chain, refusing the payment outright if none is
     * configured. A single address here could only ever be right for one chain.
     *
     * Set it only for a genuinely third-party payout, where the money is meant to
     * reach somebody who is not this business.
     */
    payoutAddress: opt('COINPAY_PAYOUT_ADDRESS'),

    /**
     * Which chain to settle on. Required by the upstream for a crypto payment.
     *
     * It must be one the payout address above is actually valid for: a BTC address
     * given an ETH payment is an address nobody controls.
     */
    blockchain: opt('COINPAY_BLOCKCHAIN', 'BTC'),
  },

  /**
   * Premium membership: what it costs, how long it lasts, and what an invite earns.
   *
   * Every number here is configuration rather than a constant because each one is a
   * commercial decision that outlives the deploy that shipped it -- a price rise, a
   * promotional term, a change to what an introduction is worth. None of them is a
   * secret; they are all printed on the page that sells the thing.
   */
  membership: {
    /** $10 a year, in cents, because money is never a float. */
    priceCents: num('MEMBERSHIP_PRICE_CENTS', 1000),
    currency: opt('MEMBERSHIP_CURRENCY', 'USD'),
    /** One term. 365 rather than a calendar year: a term is a length, not a date. */
    termDays: num('MEMBERSHIP_TERM_DAYS', 365),

    /**
     * What an inviter earns on what the people they invited spend, in basis points.
     *
     * 2000 = 20%. Basis points rather than a percentage so the rate is an integer
     * all the way from configuration to the stored ledger row, and a fraction of a
     * percent never becomes a float somewhere in the middle of an amount of money.
     *
     * Changing this does NOT re-rate anything already earned. The rate is copied
     * onto each commission row when it is written, because the deal somebody was
     * offered when they made the introduction is not a setting.
     */
    commissionBps: num('REFERRAL_COMMISSION_BPS', 2000),

    /**
     * How far back a NON-member can read their own direct messages, in days.
     *
     * The premium tier sells full message history, so the free tier has to have a
     * window -- but nothing is ever deleted. This bounds a SELECT and nothing else:
     * the rows stay, and the day somebody joins, the whole thread is there again.
     * That is the only version of this that is honest to sell.
     *
     * Zero turns the limit off entirely, which is what to set if this turns out to
     * be the wrong trade. It is a variable so that undoing it is not a deploy.
     */
    freeMessageHistoryDays: num('FREE_MESSAGE_HISTORY_DAYS', 30),

    /** Nothing can be sold without a way to take the money. */
    get enabled() {
      return Boolean(config.coinpay.enabled);
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
    /*
     * Minutes before an event that only has a DATE.
     *
     * Rare in sport and normal everywhere else: a playoff game scheduled before
     * its slot is sold, a rained-off fixture listed as "Saturday, TBD". Measured
     * against the noon anchor those are stored at, so 1440 is the day before and
     * 0 is on the day. Zero is allowed here and rejected above, because "at the
     * moment it happens" is a real choice for a date and meaningless for a time
     * that already has a one-minute offset.
     */
    dateOffsets: opt('REMINDER_DATE_OFFSETS', '1440,0')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0),
    /** Subscribers pulled per fan-out page. Queue depth stays proportional to
     *  batches, not to followers -- see packages/queue. */
    batchSize: num('REMINDER_BATCH_SIZE', 500),
    /** A reminder later than this past its due moment is dropped, not sent late.
     *  Telling someone a game starts in an hour 40 minutes after kickoff is worse
     *  than saying nothing. */
    maxLatenessSeconds: num('REMINDER_MAX_LATENESS_SECONDS', 300),
  },

  sync: {
    /**
     * Hours before the FULL fixture sweep counts as overdue at boot.
     *
     * 24, matching its repeatable. It was 6 when the sweep itself ran every 6
     * hours; the near-window pass now carries the freshness that cadence was
     * buying, at a fifth of the requests, so the sweep only has to cover what
     * genuinely moves on a slower clock -- rosters, display names, and fixtures
     * further out than the day after tomorrow.
     */
    staleHours: num('SYNC_STALE_HOURS', 24),
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

  /**
   * A reader's own SiriusXM, played here.
   *
   * The BYO rail for radio, beside the playlist one above: the reader connects
   * their own subscription with the code SiriusXM emails them, and the sports and
   * news lineups play in the page through a proxy that holds their session. The
   * session is sealed with the playlist key, so this is off wherever that is.
   *
   * On for the sports brand and off for the sibling by default: the lineups
   * offered are sports and news, and a site about film releases has no page to
   * put them on. SIRIUSXM=1 or 0 overrides either way.
   */
  radio: {
    get enabled() {
      const dflt = (process.env.BRAND ?? 'tipoffwatch') === 'tipoffwatch' ? '1' : '0';
      return (
        opt('SIRIUSXM', dflt) !== '0' && Boolean(opt('PLAYLIST_SECRET') || opt('DATABASE_URL'))
      );
    },
    /**
     * The residential exit for every SiriusXM call.
     *
     * SXM answers a datacenter address with 403 before it reads the bearer, and
     * pins a session to the IP that authenticated it, so this is not optional in
     * production. SIRIUSXM_PROXY_URL when set, else the ESPN proxy, which is the
     * same Webshare account.
     */
    get proxyUrl() {
      return opt('SIRIUSXM_PROXY_URL') || opt('SPORTS_PROXY_URL');
    },
    /**
     * A pool of single-IP proxies to pin readers to, one per line or comma.
     *
     * Each entry is `host:port:user:pass` (Webshare's export) or a full URL. A
     * reader hashes to one entry and keeps it, which is what makes their
     * session's IP the same at login, at refresh and at every segment. With no
     * pool, everything goes through proxyUrl and a rotating endpoint will
     * eventually hand a reader a different exit mid-stream.
     */
    get proxyPool() {
      return opt('SIRIUSXM_PROXIES')
        .split(/[\n,]+/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          if (/^https?:\/\//.test(line)) return line;
          const parts = line.split(':');
          if (parts.length !== 4) return '';
          const [host, port, user, pass] = parts;
          return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
        })
        .filter(Boolean);
    },
    /*
     * There is deliberately no DEVICE_GRANT setting. The token SXM asks for
     * at sign-in is minted at runtime by packages/radio, which loads the web
     * player in a headless Chromium through the proxy and reads the cookie,
     * as media-streamer does. Two environment knobs reach that code directly:
     * PUPPETEER_EXECUTABLE_PATH (the Dockerfile sets it to Debian's Chromium)
     * and SIRIUSXM_BROWSER_MINT=off, which the tests set.
     */
  },

  /**
   * Analytics, if this deployment has any.
   *
   * No default, deliberately. This id used to be hardcoded in the layout, and it
   * travelled -- a sibling site cloned from this repository spent its first day
   * counting every one of its own visitors against THIS dashboard. Nothing looked
   * wrong from either end: the tag was valid, the script loaded, views were
   * recorded. They were simply recorded here.
   *
   * The id is not a secret; it is served in the HTML to every visitor. It lives
   * in configuration because it identifies the DEPLOYMENT rather than the code.
   *
   * Read on use rather than snapshotted at import, like the playlist secret: a
   * value frozen when the module first loads cannot be changed afterwards, which
   * makes it untestable.
   */
  analytics: {
    get crawlproofSite() {
      return opt('CRAWLPROOF_SITE_ID');
    },
    get enabled() {
      return Boolean(this.crawlproofSite);
    },
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
