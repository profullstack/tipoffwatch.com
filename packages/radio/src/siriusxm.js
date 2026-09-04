/**
 * SiriusXM, over plain fetch.
 *
 * Ported from media-streamer's radio rail, which is where every constant here
 * was found: the edge-gateway paths, the curated-grouping ids for the sports and
 * news lineups, the tuneSource body, and the shape of the AES key endpoint. That
 * port ran on Node with undici's ProxyAgent; this one runs on Bun, whose fetch
 * takes a `proxy` option per request, so there is no dispatcher to keep warm and
 * no second copy of fetch to reconcile.
 *
 * Nothing in this file knows who is asking. Every function takes what it needs
 * -- a bearer, a cookie jar, a proxy -- as an argument, and `session.js` is the
 * layer that knows which reader those belong to. That is what keeps the HTTP
 * shapes testable without a database and a user in scope.
 */

const API = 'https://api.edge-gateway.siriusxm.com';

/*
 * The lineup pages. A curated grouping is SXM's word for a browse page, and the
 * container and set inside it are what the filter and sort are addressed to.
 * Found by watching the web player; there is no documented catalogue endpoint.
 */
const PAGE_ID = '403ab6a5-d3c9-4c2a-a722-a94a6a5fd056';
const CONTAINER_ID = '3JoBfOCIwo6FmTpzM1S2H7';
const SET_ID = '5mqCLZ21qAwnufKT8puUiM';

const BROWSE_URL = `${API}/browse/v1/pages/curated-grouping/${PAGE_ID}`;
const SEARCH_URL = `${API}/search/v1/search`;
const TUNE_URL = `${API}/playback/play/v1/tuneSource`;

/** The two lineups this site offers. There is deliberately no third. */
export const CATEGORIES = ['sports', 'news'];

/** Audio bitrates SXM publishes in its ladder, as the strings its URLs use. */
export const QUALITIES = ['256', '128', '64', '32'];
export const DEFAULT_QUALITY = '256';

/*
 * What the web player sends. The edge gateway answers a bare fetch with 403, and
 * the user agent is the least of it: Origin, Referer and the Sec-Fetch trio are
 * all checked. `x-sxm-clock` is a client clock-skew hint the player sends on
 * every call; the values here are the ones it uses for auth and for browse.
 */
const USER_AGENT = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0';

const headersFor = (clock) => ({
  'User-Agent': USER_AGENT,
  Accept: 'application/json; charset=utf-8',
  'Accept-Language': 'en-US,en;q=0.9',
  'x-sxm-clock': clock,
  Origin: 'https://www.siriusxm.com',
  Referer: 'https://www.siriusxm.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
});

export const AUTH_HEADERS = headersFor('[0,4999]');
export const API_HEADERS = headersFor('[0,1]');

export class SiriusXmError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP-shaped: 4xx is the reader's problem (wrong code,
   *   unknown email, not connected), 5xx is ours or SXM's.
   * @param {unknown} [data]
   */
  constructor(message, status, data = null) {
    super(message);
    this.name = 'SiriusXmError';
    this.status = status;
    this.data = data;
  }
}

/* ------------------------------------------------------------------ http -- */

/**
 * What a status means, when it did not come from SiriusXM at all.
 *
 * 402 is not in SiriusXM's vocabulary; it is the residential proxy refusing to
 * carry the request because the plan's bandwidth is spent -- the same wall the
 * ESPN sync hits. Every call goes through that proxy, so every call fails the
 * same way, and "SiriusXM would not sign in (402)" blamed the wrong party.
 */
export function explainStatus(status, otherwise) {
  if (status === 402) {
    return 'The proxy this site reaches SiriusXM through is out of bandwidth (402). SiriusXM never received the request; top the proxy up and try again.';
  }
  return otherwise;
}

const MAX_ATTEMPTS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch, with a proxy and a retry.
 *
 * A residential proxy pool hands out peers, and some of them are peers SXM
 * resets at the TLS handshake. That arrives as a thrown fetch, never as an HTTP
 * status, so only a throw is retried: a 403 is an answer and asking again gets
 * the same one.
 */
export async function sxmFetch(url, init = {}, { proxy = null } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, {
        ...init,
        ...(proxy ? { proxy } : {}),
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch (err) {
      lastErr = err;
      if (err?.name === 'AbortError' && init.signal?.aborted) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * One call to the gateway, with the cookie jar and the bearer this step holds.
 *
 * Paths are given without a leading slash. The default method is POST because
 * most of the login dance is; the two GETs say so.
 */
export async function sxmCall(
  path,
  { method = 'POST', bearer, body, cookies, query, proxy, headers = AUTH_HEADERS } = {},
) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json; charset=utf-8';
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  if (cookies) h.Cookie = cookies;

  const res = await sxmFetch(
    url,
    { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    { proxy },
  );
  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  return { status: res.status, data, raw, setCookie: res.headers.getSetCookie?.() ?? [] };
}

/* --------------------------------------------------------------- cookies -- */

/**
 * A cookie jar as one Cookie header.
 *
 * Name to value and nothing else: no domain, no path, no expiry. Every cookie
 * SXM sets is for the gateway and every call here is to the gateway, so the
 * attributes would only ever be checked against the same host. Newest wins.
 */
export function mergeCookies(existing, setCookie) {
  const jar = new Map();
  for (const pair of String(existing ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  for (const cookie of setCookie ?? []) {
    const semi = cookie.indexOf(';');
    const kv = semi === -1 ? cookie : cookie.slice(0, semi);
    const eq = kv.indexOf('=');
    if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** When a JWT says it expires, in ms, or null for anything that is not one. */
export function jwtExpiryMs(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- login -- */

/**
 * Pull the session out of a sessions/* reply, flat or nested under `session`,
 * camel or snake. SXM has answered both ways.
 */
function extractSession(reply, jar) {
  const root = reply.data && typeof reply.data === 'object' ? reply.data : {};
  const s = root.session && typeof root.session === 'object' ? root.session : root;
  const accessToken = s.accessToken ?? s.access_token;
  if (!accessToken) {
    throw new SiriusXmError(`no accessToken in session response: ${reply.raw.slice(0, 300)}`, 502);
  }
  return {
    accessToken,
    accessTokenExpiresAt: s.accessTokenExpiresAt ?? s.access_token_expires_at ?? null,
    refreshTokenExpiresAt: s.refreshTokenExpiresAt ?? s.refresh_token_expires_at ?? null,
    cookies: mergeCookies(jar, reply.setCookie),
  };
}

const OTP_BODY = (identityId) => ({
  identityId,
  otpOption: 'EMAIL',
  otpContext: 'sign-in',
  language: 'en-US',
});

/* ---------------------------------------------------------- device grant -- */

/**
 * Mint DEVICE_GRANT the way media-streamer does: load the web player in a real
 * headless browser, through the same proxy the fetches use, and read the cookie
 * its JavaScript writes. Plain fetch cannot run that JavaScript, which is why
 * the fetch spellings below almost always answer 403.
 *
 * Chromium comes from PUPPETEER_EXECUTABLE_PATH (the Docker image installs
 * Debian's and sets it), or puppeteer-core's usual guesses. Resources are not
 * blocked, since the player's bootstrap scripts are what set the cookie.
 * SIRIUSXM_BROWSER_MINT=off skips this step -- the tests set it, so a box with
 * a Chromium never reaches siriusxm.com from the suite.
 */
async function mintDeviceGrantViaBrowser({ proxy }) {
  if ((process.env.SIRIUSXM_BROWSER_MINT ?? 'on') === 'off') {
    throw new SiriusXmError('browser mint is off (SIRIUSXM_BROWSER_MINT=off)', 502);
  }
  const { default: puppeteer } = await import('puppeteer-core');
  const proxyUrl = proxy ? new URL(proxy) : null;
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const browser = await puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      ...(proxyUrl ? [`--proxy-server=${proxyUrl.protocol}//${proxyUrl.host}`] : []),
    ],
  });
  try {
    const page = await browser.newPage();
    if (proxyUrl?.username) {
      await page.authenticate({
        username: decodeURIComponent(proxyUrl.username),
        password: decodeURIComponent(proxyUrl.password),
      });
    }
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Every edge-gateway answer, so a failure says whether the device-grant
    // XHR fired at all and what SXM said to it.
    const apiLog = [];
    page.on('response', async (res) => {
      const url = res.url();
      if (!url.includes('api.edge-gateway.siriusxm.com')) return;
      const path = url.replace(/^https:\/\/api\.edge-gateway\.siriusxm\.com/, '');
      const status = res.status();
      let extra = '';
      if (status >= 400 && path.startsWith('/device/')) {
        extra = ` body=${(await res.text().catch(() => '')).slice(0, 200)}`;
      }
      apiLog.push(`${status} ${path.slice(0, 120)}${extra}`);
    });

    // The player is the surface that needs DEVICE_GRANT; the homepage may not
    // bootstrap one at all.
    const candidates = [
      'https://www.siriusxm.com/player/',
      'https://player.siriusxm.com/',
      'https://www.siriusxm.com/listen',
      'https://www.siriusxm.com/',
    ];
    const origins = [
      'https://www.siriusxm.com',
      'https://siriusxm.com',
      'https://player.siriusxm.com',
      'https://api.edge-gateway.siriusxm.com',
    ];
    for (const url of candidates) {
      // domcontentloaded, not idle: SXM's trackers never settle, least of all
      // through a proxy. A timeout still falls through to the cookie poll,
      // since the cookie may have been written during the partial load.
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch {
        // poll anyway
      }
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const cookies = await page.cookies(...origins);
        const dg = cookies.find((c) => c.name === 'DEVICE_GRANT' && c.value);
        if (dg) return parseDeviceGrant(dg.value);
        await sleep(500);
      }
    }

    const cookies = await page.cookies(...origins);
    const cookieSummary = cookies.map((c) => `${c.name}@${c.domain ?? '?'}`).join(', ');
    throw new SiriusXmError(
      `browser: DEVICE_GRANT not minted across ${candidates.length} pages. ` +
        `edge-gateway answers: [${apiLog.slice(0, 12).join(' | ') || 'none'}]. ` +
        `Cookies: [${cookieSummary || 'none'}]`,
      502,
    );
  } finally {
    await browser.close();
  }
}

/** A minted grant is reused until ten minutes before it expires. */
const GRANT_REFRESH_BUFFER_MS = 10 * 60 * 1000;
let mintedGrant = null; // { value, expiresAtMs }
let inflightMint = null;

export function resetDeviceGrantCache() {
  mintedGrant = null;
  inflightMint = null;
}

/**
 * The bootstrap token a bare session needs, when SXM asks for one.
 *
 * In order, exactly as media-streamer does it:
 *   1. A grant the caller handed in. The app never does; the tests do, to run
 *      the anonymous-session dance against the fake gateway with no browser.
 *   2. The last browser-minted grant, while it is well inside its TTL.
 *   3. A headless browser loading the web player through the proxy, one mint
 *      at a time no matter how many sign-ins are waiting on it.
 *   4. The fetch spellings, which cost nothing and occasionally work.
 *
 * Nothing is read from configuration: the token is minted, not stored. When
 * every step fails the error carries what each of them said.
 */
async function bootstrapDeviceGrant({ proxy, pasted }) {
  if (pasted) return parseDeviceGrant(pasted);

  if (mintedGrant && Date.now() + GRANT_REFRESH_BUFFER_MS < mintedGrant.expiresAtMs) {
    return mintedGrant.value;
  }

  if (!inflightMint) {
    inflightMint = mintDeviceGrantViaBrowser({ proxy })
      .then((grant) => {
        const expMs = grant.grantExpiresAt
          ? Date.parse(grant.grantExpiresAt)
          : Date.now() + 24 * 60 * 60 * 1000;
        mintedGrant = { value: grant, expiresAtMs: expMs };
        return grant;
      })
      .finally(() => {
        inflightMint = null;
      });
  }
  let browserErr;
  try {
    return await inflightMint;
  } catch (err) {
    browserErr = err;
  }

  return bootstrapDeviceGrantViaFetch({ proxy, browserErr });
}

async function bootstrapDeviceGrantViaFetch({ proxy, browserErr }) {
  const attempts = [
    {
      url: 'https://www.siriusxm.com/',
      init: {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      },
    },
    {
      url: `${API}/device/v1/grants`,
      init: {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
        body: '{}',
      },
    },
  ];
  const log = [];
  for (const { url, init } of attempts) {
    let res;
    try {
      res = await sxmFetch(url, init, { proxy });
    } catch (err) {
      log.push(`${url}: ${err?.message ?? err}`);
      continue;
    }
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = c.match(/^DEVICE_GRANT=([^;]+)/);
      if (m) {
        try {
          return parseDeviceGrant(m[1]);
        } catch {
          // not a grant after all; keep looking
        }
      }
    }
    const text = await res.text().catch(() => '');
    if (text.startsWith('{')) {
      try {
        const json = JSON.parse(text);
        const g = json?.grant ? json : json?.deviceGrant;
        if (g?.grant) return g;
      } catch {
        // fall through
      }
    }
    log.push(`${url}: HTTP ${res.status}`);
  }
  throw new SiriusXmError(
    'SiriusXM would not start a sign-in from this server. It asks for a device token that only its web player mints, and the headless browser could not mint one.',
    502,
    { browser: browserErr?.message ?? String(browserErr), fetch: log },
  );
}

function parseDeviceGrant(raw) {
  let s = String(raw).trim();
  if (s.startsWith('%')) {
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep as is
    }
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (err) {
    throw new SiriusXmError(`DEVICE_GRANT is not valid JSON: ${err.message}`, 400);
  }
  if (!parsed?.grant) throw new SiriusXmError('DEVICE_GRANT JSON has no .grant field', 400);
  return parsed;
}

/**
 * Stage one: find the account, send the code.
 *
 * Tried first with no bearer at all -- SXM does not always insist on a session
 * to answer "is this email registered" and "send them a code" -- and only if it
 * does is the anonymous-session dance run underneath it. Returns what stage two
 * needs and nothing a reader could use on its own.
 *
 * @returns {Promise<{identityId: string, anonAccessToken: string, cookies: string}>}
 */
export async function startOtpLogin(email, { proxy = null, deviceGrant = null } = {}) {
  let jar = '';

  const unauth = await sxmCall('identity/v1/identities/status', {
    method: 'GET',
    query: { handle: email },
    proxy,
  });
  const needsSession = unauth.status === 401 || unauth.status === 403;
  let bearer = '';

  if (needsSession) {
    const grant = await bootstrapDeviceGrant({ proxy, pasted: deviceGrant });
    const anon = await sxmCall('session/v1/sessions/anonymous', {
      bearer: grant.grant,
      proxy,
    });
    if (anon.status >= 400) {
      throw new SiriusXmError(
        explainStatus(anon.status, `anonymous session failed: ${anon.status}`),
        502,
        anon.data,
      );
    }
    jar = mergeCookies(jar, anon.setCookie);
    bearer = extractSession(anon, jar).accessToken;
  }

  const status = needsSession
    ? await sxmCall('identity/v1/identities/status', {
        method: 'GET',
        bearer,
        query: { handle: email },
        cookies: jar,
        proxy,
      })
    : unauth;
  if (status.status >= 400) {
    throw new SiriusXmError(
      explainStatus(status.status, `identity status failed: ${status.status}`),
      502,
      status.data,
    );
  }
  jar = mergeCookies(jar, status.setCookie);
  const identityId = status.data?.identityId;
  if (!identityId) {
    throw new SiriusXmError('SiriusXM does not know that email address.', 404, status.data);
  }

  const initiate = await sxmCall('otp/v1/otp/initiate', {
    bearer: bearer || undefined,
    cookies: jar,
    body: OTP_BODY(identityId),
    proxy,
  });
  if (initiate.status >= 400) {
    throw new SiriusXmError(
      explainStatus(initiate.status, `SiriusXM would not send a code (${initiate.status}).`),
      502,
      initiate.data,
    );
  }
  jar = mergeCookies(jar, initiate.setCookie);

  return { identityId, anonAccessToken: bearer, cookies: jar };
}

/**
 * Stage two: the code from the email becomes a session.
 *
 * Three hops, each one's grant the next one's bearer. The last reply carries the
 * Set-Cookie jar that `refreshSession` replays, which is why the jar is part of
 * what gets stored and not just the token.
 */
export async function completeOtpLogin(state, otp, { proxy = null } = {}) {
  let jar = state.cookies ?? '';
  // An empty anon token means stage one never needed a session. That has to be
  // no header at all, not "Bearer ".
  const bearer = state.anonAccessToken || undefined;

  const redeem = await sxmCall('otp/v1/otp/redeem', {
    method: 'PUT',
    bearer,
    cookies: jar,
    body: { identityId: state.identityId, otp },
    proxy,
  });
  if (redeem.status >= 400) {
    throw new SiriusXmError(
      [400, 401, 403].includes(redeem.status)
        ? 'That code was not accepted. Check it and try again, or send a new one.'
        : `otp redeem failed: ${redeem.status}`,
      redeem.status >= 500 ? 502 : 400,
      redeem.data,
    );
  }
  jar = mergeCookies(jar, redeem.setCookie);
  const otpGrant = redeem.data?.grant;
  if (!otpGrant) throw new SiriusXmError('no grant in otp redeem response', 502);

  const idAuth = await sxmCall('identity/v1/identities/authenticate/otp', {
    bearer: otpGrant,
    cookies: jar,
    proxy,
  });
  if (idAuth.status >= 400) {
    throw new SiriusXmError(`identity authenticate failed: ${idAuth.status}`, 502, idAuth.data);
  }
  jar = mergeCookies(jar, idAuth.setCookie);
  const identityGrant = idAuth.data?.grant;
  if (!identityGrant) throw new SiriusXmError('no grant in identity authenticate response', 502);

  const authed = await sxmCall('session/v1/sessions/authenticated', {
    bearer: identityGrant,
    cookies: jar,
    proxy,
  });
  if (authed.status >= 400) {
    throw new SiriusXmError(`sessions/authenticated failed: ${authed.status}`, 502, authed.data);
  }
  return extractSession(authed, jar);
}

/**
 * The other door: the account password.
 *
 * What the SiriusXM web player does when a reader types a password rather than
 * asking for a code (read from its bundle, 2026-09-03: endpoint
 * `authenticatePassword`, body `{handle, password}`, bearer the anonymous
 * session's access token; the reply is an identity grant, and
 * `sessions/authenticated` turns it into a session the same way the OTP path
 * does). Tried first with no bearer, as the OTP start is; only if the gateway
 * insists is the anonymous session minted underneath it.
 *
 * The password is used for this one call and never stored -- what is kept is
 * the session it produced, which is all the OTP path keeps too.
 */
export async function passwordLogin(handle, password, { proxy = null, deviceGrant = null } = {}) {
  let jar = '';
  const body = { handle, password };
  const attempt = (bearer) =>
    sxmCall('identity/v1/identities/authenticate/password', {
      bearer: bearer || undefined,
      cookies: jar,
      body,
      proxy,
    });

  let reply = await attempt('');
  if (reply.status === 401 || reply.status === 403) {
    const grant = await bootstrapDeviceGrant({ proxy, pasted: deviceGrant });
    const anon = await sxmCall('session/v1/sessions/anonymous', { bearer: grant.grant, proxy });
    if (anon.status >= 400) {
      throw new SiriusXmError(
        explainStatus(anon.status, `anonymous session failed: ${anon.status}`),
        502,
        anon.data,
      );
    }
    jar = mergeCookies(jar, anon.setCookie);
    reply = await attempt(extractSession(anon, jar).accessToken);
  }
  if (reply.status >= 400) {
    throw new SiriusXmError(
      [400, 401, 403, 404].includes(reply.status)
        ? 'SiriusXM did not accept that email and password.'
        : explainStatus(reply.status, `SiriusXM would not sign in (${reply.status}).`),
      reply.status === 402 || reply.status >= 500 ? 502 : 400,
      reply.data,
    );
  }
  jar = mergeCookies(jar, reply.setCookie);
  const identityGrant = reply.data?.grant ?? reply.data?.identityGrant?.grant;
  if (!identityGrant) {
    throw new SiriusXmError(`no grant in password response: ${reply.raw.slice(0, 300)}`, 502);
  }

  const authed = await sxmCall('session/v1/sessions/authenticated', {
    bearer: identityGrant,
    cookies: jar,
    proxy,
  });
  if (authed.status >= 400) {
    throw new SiriusXmError(`sessions/authenticated failed: ${authed.status}`, 502, authed.data);
  }
  return extractSession(authed, jar);
}

/** A new access token from the jar alone. No bearer: the cookies are the refresh. */
export async function refreshSession(cookies, { proxy = null } = {}) {
  const reply = await sxmCall('session/v1/sessions/refresh', { cookies, body: {}, proxy });
  if (reply.status >= 400) {
    throw new SiriusXmError(
      `SiriusXM session could not be refreshed (${reply.status}).`,
      reply.status === 401 || reply.status === 403 ? 401 : 502,
      reply.data,
    );
  }
  return extractSession(reply, cookies);
}

/* -------------------------------------------------------------- channels -- */

const STATION_PREFIX = 'sxm:';
const CHANNEL_TYPES = new Set(['channel-linear', 'channel-xtra']);

/** `sxm:<type>:<id>`, the one id a channel has on this site. */
export function stationId(channelId, type) {
  return `${STATION_PREFIX}${type}:${channelId}`;
}

export function parseStationId(id) {
  if (typeof id !== 'string' || !id.startsWith(STATION_PREFIX)) return null;
  const rest = id.slice(STATION_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const type = rest.slice(0, colon);
  const channelId = rest.slice(colon + 1);
  if (!channelId || !CHANNEL_TYPES.has(type)) return null;
  // A channel id is an opaque token from SXM, never a path: anything that could
  // walk out of a URL is refused here rather than at every place it is used.
  if (!/^[A-Za-z0-9._-]+$/.test(channelId)) return null;
  return { id: channelId, type };
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

/**
 * The browse query, as the web player encodes it: a version prefix and a
 * base64url JSON blob. The filter ids are SXM's own category slugs.
 */
export function categoryQuery(cat) {
  const filter =
    cat === 'news'
      ? { and: [{ filterId: 'talk' }, { filterId: 'talk--news-and-politics' }] }
      : { one: { filterId: 'sports' } };
  const q = {
    containerConfiguration: {
      [CONTAINER_ID]: {
        filter,
        sets: { [SET_ID]: { sort: { sortId: 'CHANNEL_NUMBER_ASC' } } },
      },
    },
    pagination: { offset: { containerLimit: 6, containerOffset: 0, setItemsLimit: 100 } },
    deviceCapabilities: { supportsDownloads: false },
    constraints: {
      supportedEntityTypes: [
        'artist-station',
        'brand',
        'channel-linear',
        'channel-xtra',
        'container',
        'curated-grouping',
        'episode-audio',
        'episode-linear',
        'episode-podcast',
        'episode-video',
        'event',
        'experience',
        'genre',
        'league',
        'show',
        'show-podcast',
        'station',
        'tag-topic',
        'talent',
        'team',
        'user-signal',
      ],
    },
  };
  return `1.${b64url(q)}`;
}

/*
 * Channel art. The API returns relative keys, and the CDN wants them wrapped in
 * a base64 JSON envelope naming the edits -- format and a square resize. Standard
 * base64 here, where the browse query above is base64url; they are different
 * services and disagree.
 */
const IMAGE_CDN = 'https://imgsrv-sxm-prod-device.streaming.siriusxm.com/';
const IMAGE_SIZE = 300;

export function imageUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (/^https?:\/\//.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  const key = raw.replace(/^\/+/, '');
  const payload = JSON.stringify({
    key,
    edits: [
      { format: { type: /\.png(\?|$)/i.test(key) ? 'png' : 'jpeg' } },
      { resize: { width: IMAGE_SIZE, height: IMAGE_SIZE } },
    ],
  });
  return `${IMAGE_CDN}${Buffer.from(payload, 'utf8').toString('base64')}`;
}

function findUrl(node) {
  if (!node) return null;
  if (typeof node === 'string') return imageUrl(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const key of ['url', 'src', 'href']) {
      if (typeof node[key] === 'string') return imageUrl(node[key]);
    }
    for (const value of Object.values(node)) {
      const found = findUrl(value);
      if (found) return found;
    }
  }
  return null;
}

/** Square tile first; the wide hero and background branches are a last resort. */
function pickImage(entity) {
  const images = entity?.images;
  if (!images || typeof images !== 'object') return null;
  for (const branch of ['tile', 'tile_background', 'logo', 'hero_tile', 'background']) {
    const b = images[branch];
    if (!b || typeof b !== 'object') continue;
    for (const aspect of ['aspect_1x1', 'aspect_5x4', 'aspect_16x9', 'aspect_4x3', 'aspect_15x7']) {
      const url = findUrl(b[aspect]);
      if (url) return url;
    }
  }
  return findUrl(images);
}

const pickText = (t) => t?.default || t?.short || t?.medium || t?.long || '';

/**
 * One browse or search item as a channel, or null for anything that is not one
 * (a show, a talent, an episode -- the lineup pages carry all of them).
 *
 * @returns {{id: string, type: string, number: number|null, title: string,
 *   description: string|null, image: string|null, stationId: string}|null}
 */
export function itemToChannel(item) {
  const entity = item?.entity;
  if (!entity?.id) return null;
  const type = entity.type || 'channel-linear';
  if (!CHANNEL_TYPES.has(type)) return null;
  const title = pickText(entity.texts?.title);
  if (!title) return null;
  const n = item?.decorations?.channelNumberCanonical ?? item?.decorations?.channelNumber;
  return {
    id: entity.id,
    type,
    number: typeof n === 'number' ? n : null,
    title,
    description: pickText(entity.texts?.description) || null,
    image: pickImage(entity),
    stationId: stationId(entity.id, type),
  };
}

/** Distinct, in channel-number order, unnumbered ones last by name. */
export function dedupeChannels(channels) {
  const seen = new Set();
  const out = [];
  for (const ch of channels) {
    const key = `${ch.type}:${ch.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ch);
  }
  return out.sort((a, b) => {
    const an = a.number ?? 999_999;
    const bn = b.number ?? 999_999;
    return an !== bn ? an - bn : a.title.localeCompare(b.title);
  });
}

function itemsOf(sets) {
  const out = [];
  for (const set of sets ?? []) {
    for (const item of set?.items ?? []) {
      const ch = itemToChannel(item);
      if (ch) out.push(ch);
    }
  }
  return out;
}

/**
 * A JSON call with a reader's bearer. `unauthorized` is called before the one
 * retry a 401/403 earns, so the caller can drop a cached token and mint a new
 * bearer; the second answer is final.
 */
async function apiJson(url, init, { bearer, proxy, unauthorized }) {
  const send = async (token) =>
    sxmFetch(
      url,
      { ...init, headers: { ...API_HEADERS, Authorization: `Bearer ${token}`, ...init.headers } },
      { proxy },
    );
  let res = await send(await bearer());
  if ((res.status === 401 || res.status === 403) && unauthorized) {
    await unauthorized();
    res = await send(await bearer());
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new SiriusXmError(
      'SiriusXM no longer accepts this session. Connect your account again in settings.',
      401,
      text.slice(0, 300),
    );
  }
  if (!res.ok) {
    throw new SiriusXmError(
      explainStatus(res.status, `SiriusXM answered ${res.status}`),
      502,
      text.slice(0, 300),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SiriusXmError(
      'SiriusXM answered something that is not JSON',
      502,
      text.slice(0, 200),
    );
  }
}

export async function browseChannels(cat, ctx) {
  const url = `${BROWSE_URL}?q=${encodeURIComponent(categoryQuery(cat))}`;
  const json = await apiJson(url, { method: 'GET' }, ctx);
  const channels = [];
  for (const container of json?.page?.containers ?? []) channels.push(...itemsOf(container?.sets));
  return dedupeChannels(channels);
}

export async function searchChannels(query, ctx) {
  const json = await apiJson(
    SEARCH_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        searchString: query,
        filterTypes: ['channel-xtra', 'channel-linear'],
        preferredImageVariant: 'default',
      }),
    },
    ctx,
  );
  return dedupeChannels(itemsOf(json?.container?.sets));
}

/**
 * A playback URL for one channel. Signed, short-lived, and pinned to the IP
 * that asked -- which is why the proxy that fetched it is the proxy that must
 * fetch every byte behind it.
 *
 * @returns {Promise<{url: string, validUntil: string|null}>}
 */
export async function tuneChannel({ id, type }, ctx) {
  const json = await apiJson(
    TUNE_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        id,
        type,
        manifestVariant: 'WEB',
        trackResumeSupported: false,
        hlsVersion: 'V3',
        mtcVersion: 'V2',
      }),
    },
    ctx,
  );
  const urls = json?.streams?.[0]?.urls ?? [];
  const primary = urls.find((u) => u?.isPrimary) ?? urls[0];
  if (!primary?.url) {
    // The reply says why -- not in the plan, wrong region, session/IP mismatch --
    // and hiding it behind a generic line is how those got blamed on the proxy.
    throw new SiriusXmError(
      'SiriusXM did not offer a stream for that channel. It may not be in your plan.',
      502,
      JSON.stringify(json ?? {}).slice(0, 500),
    );
  }
  return { url: primary.url, validUntil: primary.validUntil ?? null };
}

/* ------------------------------------------------------------------- hls -- */

/** Only SXM's own hosts may be fetched on a reader's behalf. */
export function isSiriusXmUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)siriusxm\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

export function looksLikePlaylist(url, contentType) {
  const ct = String(contentType ?? '').toLowerCase();
  return (
    url.includes('.m3u8') ||
    ct.includes('mpegurl') ||
    ct.includes('m3u') ||
    ct.includes('vnd.apple')
  );
}

export const isKeyUrl = (url) => url.includes('/playback/key/v1/');

const absolutize = (uri, base) => new URL(uri, base).toString();

/**
 * Collapse a master playlist to the one variant the reader asked for.
 *
 * SXM's ladder names the bitrate in the variant URL, so a substring match is
 * the honest selector; bandwidth breaks ties and stands in when the name is
 * missing. One variant rather than the ladder because the ladder is four
 * copies of the same audio, and an adaptive player that steps down on a wobble
 * is worse than one that just buffers a moment.
 */
function chooseVariant(text, playlistUrl, quality) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = lines[i + 1];
    if (!uri || uri.startsWith('#')) continue;
    const bandwidth = Number(lines[i].match(/BANDWIDTH=(\d+)/i)?.[1] ?? 0);
    const abs = absolutize(uri, playlistUrl);
    const named = abs.includes(`_${quality}k_`) || abs.includes(`${quality}k`);
    variants.push({ info: lines[i], uri: abs, score: (named ? 10_000_000 : 0) + bandwidth });
  }
  if (variants.length === 0) return null;
  variants.sort((a, b) => b.score - a.score);
  return ['#EXTM3U', '#EXT-X-VERSION:3', variants[0].info, variants[0].uri, ''].join('\n');
}

/**
 * Every address in a playlist, pointed back at us.
 *
 * Segments, child playlists and the AES key all go through `proxify`, which
 * builds the same-origin URL that carries the reader's session. The browser
 * therefore never sees a siriusxm.com address and never needs the bearer.
 */
export function rewritePlaylist(text, playlistUrl, quality, proxify) {
  const source = chooseVariant(text, playlistUrl, quality) ?? text;
  const out = [];
  for (const line of source.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      out.push(line);
      continue;
    }
    if (t.startsWith('#EXT-X-KEY')) {
      out.push(
        line.replace(
          /URI="([^"]+)"/,
          (_m, uri) => `URI="${proxify(absolutize(uri, playlistUrl))}"`,
        ),
      );
      continue;
    }
    if (t.startsWith('#')) {
      out.push(line);
      continue;
    }
    out.push(proxify(absolutize(t, playlistUrl)));
  }
  return out.join('\n');
}

/**
 * The AES-128 key, as bytes.
 *
 * SXM serves it as JSON, under a field name that has changed over time; an HLS
 * player wants the sixteen raw bytes and decodes garbage if it is handed the
 * JSON. Base64 and base64url are tried before hex before literal text.
 */
export function decodeKeyJson(json) {
  const obj = json && typeof json === 'object' ? json : {};
  const result = obj.result && typeof obj.result === 'object' ? obj.result : {};
  const raw = [
    obj.key,
    obj.value,
    obj.keyValue,
    obj.encryptionKey,
    obj.encryptionKeyValue,
    obj.data,
    obj.payload,
    result.key,
    result.value,
  ].find((v) => typeof v === 'string');
  if (!raw) {
    throw new SiriusXmError(
      `no key in SiriusXM key response: ${JSON.stringify(json).slice(0, 200)}`,
      502,
    );
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(raw)) {
    return Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  }
  if (/^[a-fA-F0-9]+$/.test(raw) && raw.length % 2 === 0) return Buffer.from(raw, 'hex');
  return Buffer.from(raw, 'utf8');
}
