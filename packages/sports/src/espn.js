/**
 * ESPN adapter.
 *
 * ESPN publishes an unauthenticated JSON API behind espn.com. It is not documented
 * and carries no SLA, which is exactly why every response is normalised here and
 * persisted in Postgres immediately: the calendar is served from our own tables, so
 * an ESPN outage degrades freshness rather than blanking the site.
 *
 * Two endpoints are used:
 *   sports.core.api.espn.com/v2  -- catalogue (which sports, which leagues)
 *   site.api.espn.com/apis/site  -- scoreboard (the actual fixtures)
 *
 * Verified 2026-08-19: 17 sports, 354 leagues, 216 of them soccer.
 */

import { config } from '@tipoff/config';
import { canonicalBroadcaster } from './broadcasters.js';

const CORE = 'https://sports.core.api.espn.com/v2';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';

/** A scoreboard response caps out around 100 events regardless of `limit`. */
const PAGE_CAP = 100;

export const name = 'espn';

/** Leagues people actually follow, polled ahead of the long tail. */
const PRIORITY = new Map([
  ['nfl', 1],
  ['nba', 1],
  ['mlb', 1],
  ['nhl', 1],
  ['eng.1', 1],
  ['esp.1', 1],
  ['ger.1', 1],
  ['ita.1', 1],
  ['fra.1', 1],
  ['uefa.champions', 1],
  ['fifa.world', 1],
  ['usa.1', 2],
  ['mex.1', 2],
  ['college-football', 2],
  ['mens-college-basketball', 2],
  ['f1', 2],
  ['atp', 3],
  ['wta', 3],
  ['ufc', 3],
]);

/**
 * ESPN filters on User-Agent, and Bun's default is on the wrong side of it.
 *
 * Verified 2026-08-19: no UA, a browser UA, `node-fetch/*`, `Wget/*` and a plain
 * custom app string all get `403 Access Denied` with an HTML body, while `curl/*`,
 * `okhttp/*`, `python-requests/*` and `Go-http-client/*` get JSON. It is an
 * allowlist of recognised API clients, not a bot block.
 *
 * So the UA is curl-prefixed to clear the filter, with our own URL appended so we
 * are still identifiable and contactable rather than pretending to be something we
 * are not. Both halves are load-bearing: drop the prefix and every request 403s,
 * which is silent because the catch below turns it into an empty result.
 */
const USER_AGENT = 'curl/8.5.0 (+https://tipoffwatch.com)';

/**
 * ESPN requests go through the residential proxy whenever one is configured.
 *
 * ESPN blocks datacenter egress: the identical request that returns JSON from a
 * laptop returns 403 Access Denied from Railway, and it silently took production's
 * sync down for two hours. So the proxy is the normal route and stays that way.
 *
 * What is NOT the normal route is the proxy failing as a BILLING account. On
 * 2026-08-24 the plan ran out of bandwidth mid-evening and every request started
 * coming back `402 Bandwidth limit reached. Please upgrade to continue using the
 * proxy.` -- for sixteen hours. Every score froze, and because a frozen score is
 * still a score the site went on presenting yesterday's fixtures as in progress.
 *
 * A blanket direct-first fallback was tried once before and was rightly reverted:
 * a block does not always arrive as a status, so the direct attempt could throw,
 * and every request paid a doomed round trip before the one that worked. This is
 * the narrow version of it, and the difference is which side is at fault:
 *
 *   - 402/407 is the PROXY refusing us, and says nothing about ESPN. Going direct
 *     is strictly better than not going at all.
 *   - 403/429 is ESPN refusing the proxy's exit IP. A datacenter IP fares worse,
 *     so retrying direct would burn a round trip to be blocked again.
 *
 * And it is a circuit breaker rather than a per-request retry, so an exhausted
 * plan costs one doomed BURST per PROXY_COOLDOWN_MS instead of one per request.
 * A burst, not a single probe, and the distinction is worth stating: the score
 * tick fetches its leagues concurrently, so every request already in flight when
 * the first 402 lands has passed the check too. Measured at ten on the first pass
 * after this shipped, then none until the cooldown expires. That is left alone
 * deliberately -- serialising the probe would mean holding every league's fetch
 * behind one request on the happy path, which is a real cost every minute to save
 * ten 68-byte error responses every five.
 *
 * It re-arms itself: when the plan is topped up the next probe succeeds and the
 * proxy is in use again with no deploy.
 */
const PROXY_COOLDOWN_MS = 5 * 60_000;

/** Set while the proxy is known-unusable; the value is when to try it again. */
let proxyBlockedUntil = 0;

/** Statuses that mean the PROXY rejected us, not that ESPN did. */
const PROXY_FAULT = new Set([402, 407]);

/** Visible for tests, and for a caller that wants to force a re-probe. */
export function resetProxyBreaker() {
  proxyBlockedUntil = 0;
}

async function getJson(url, { timeoutMs = 20000, log = console.warn } = {}) {
  const configured = config.sports.proxyUrl;
  const useProxy = Boolean(configured) && Date.now() >= proxyBlockedUntil;

  const attempt = (proxy) =>
    fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      ...(proxy ? { proxy } : {}),
    });

  let res;
  try {
    res = await attempt(useProxy ? configured : null);
  } catch (err) {
    // A proxy that will not even connect is the same class of problem as one that
    // answers 402, and it arrives as a throw rather than a status.
    if (!useProxy) throw err;
    proxyBlockedUntil = Date.now() + PROXY_COOLDOWN_MS;
    log(`[espn] proxy unreachable (${err?.message ?? err}); going direct for 5 minutes`);
    return getJson(url, { timeoutMs, log });
  }

  if (useProxy && PROXY_FAULT.has(res.status)) {
    /*
     * Read the body before discarding it: this is the one message that says which
     * account is out of what, and it is the difference between "top up Webshare"
     * and sixteen hours of guessing.
     */
    const why = await res.text().catch(() => '');
    proxyBlockedUntil = Date.now() + PROXY_COOLDOWN_MS;
    log(`[espn] proxy ${res.status}: ${why.trim().slice(0, 160)} -- going direct for 5 minutes`);
    return getJson(url, { timeoutMs, log });
  }

  if (!res.ok) {
    throw new Error(`espn ${res.status}${useProxy ? ' (via proxy)' : ' (direct)'} ${url}`);
  }
  return res.json();
}

/**
 * Where a league is played, if the provider will say.
 *
 * The country lives ONLY on the core league endpoint, and only for domestic
 * soccer. It is not on the scoreboard -- which would have been free, since that
 * response is fetched anyway -- so this is a request per league, and the caller
 * is expected to spend them a few at a time rather than sweeping 354 a night.
 *
 * Returns null for every non-soccer league and for continental competitions,
 * which is a fact about the provider rather than a failure: see regions.js for
 * what fills the gap.
 */
export async function fetchLeagueRegion(providerKey) {
  const [sport, slug] = String(providerKey).split('/');
  if (!sport || !slug) return null;
  try {
    const j = await getJson(`${CORE}/sports/${sport}/leagues/${slug}`);
    return j?.country?.name ?? null;
  } catch {
    // A league whose detail endpoint 404s still has fixtures and a name. This is
    // decoration; it must never be able to fail a sync.
    return null;
  }
}

/** The `$ref` links carry the slug in the path; parsing it beats a fetch per league. */
const slugFromRef = (ref, segment) => ref.split(`/${segment}/`)[1].split('?')[0];

/**
 * Every sport and league ESPN knows about. Cheap enough (18 requests) to re-run
 * daily, which is how new competitions appear without a deploy.
 */
export async function listLeagues() {
  const sports = (await getJson(`${CORE}/sports?limit=50`)).items.map((i) =>
    slugFromRef(i.$ref, 'sports'),
  );

  const out = [];
  for (const sport of sports) {
    let page;
    try {
      page = await getJson(`${CORE}/sports/${sport}/leagues?limit=1000`);
    } catch {
      // A sport with no leagues (cricket, currently) 404s rather than returning
      // an empty list. Not an error worth failing the whole catalogue over.
      continue;
    }
    for (const item of page.items ?? []) {
      const key = slugFromRef(item.$ref, 'leagues');
      out.push({
        provider: 'espn',
        provider_key: `${sport}/${key}`,
        sport,
        // Underscores are kept distinct from dots on purpose: ESPN ships both
        // `fifa.intercontinental_cup` and `fifa.intercontinental.cup`, and folding
        // both separators to `-` collapses them into one slug that then violates
        // the unique constraint mid-sync.
        slug: `${sport}-${key}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
        name: key,
        abbreviation: null,
        logo_url: null,
        priority: PRIORITY.get(key) ?? 100,
      });
    }
  }
  return out;
}

/**
 * Every team in a league, whether or not it plays soon.
 *
 * The fixture sweep only ever sees teams with a game inside the horizon, so a
 * follow picker built from fixtures alone shows whoever happens to be playing this
 * fortnight -- eight Premier League clubs instead of twenty. This is the roster.
 *
 * Individual sports (tennis, golf, racing) have no teams endpoint and 404 here,
 * which is expected rather than an error.
 */
export async function fetchTeams(providerKey) {
  let data;
  try {
    // Without an explicit limit the teams endpoint returns only the first 50, so
    // college football silently synced 50 of its 759 programmes and the picker was
    // missing most of the league rather than obviously broken.
    data = await getJson(`${SITE}/${providerKey}/teams?limit=1000`);
  } catch {
    return [];
  }

  const entries = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];

  return entries
    .map((entry) => entry.team)
    .filter(Boolean)
    .map((t) => ({
      // Keyed by LEAGUE, not sport. ESPN team ids are only unique within a league:
      // id 7 is the Denver Broncos in the NFL and the Amherst Mammoths in college
      // football, and 20 NFL ids collide with college ones. Keying by sport merged
      // them, so the upsert overwrote the names and the NFL page listed college
      // teams playing each other.
      providerKey: `${providerKey}/${t.id}`,
      name: t.name ?? t.displayName ?? t.shortDisplayName ?? 'Unknown',
      displayName: t.displayName ?? t.name ?? 'Unknown',
      abbreviation: t.abbreviation ?? null,
      logoUrl: t.logos?.[0]?.href ?? t.logo ?? null,
    }));
}

/** 1 -> "1st". Only used when the provider ships no period label of its own. */
const ordinal = (n) => {
  if (!Number.isFinite(n)) return null;
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/**
 * One provider play -> our row shape, or null if it is not usable.
 *
 * Every sport's play object carries the same core fields (`id`, `text`,
 * `scoringPlay`, `period`), which is what makes one mapper enough for the three
 * different containers below.
 */
const normalisePlay = (p, { sequence = null } = {}) => {
  if (!p?.id || !p?.text) return null;

  // Checked for absence before conversion, because Number(null) is 0 -- which would
  // file every unsequenced play at the top of the log rather than leaving it
  // unordered for the id to break.
  const rawSeq = p.sequenceNumber ?? sequence;
  const seq =
    rawSeq === null || rawSeq === undefined || rawSeq === '' ? Number.NaN : Number(rawSeq);
  const periodNumber = Number.isFinite(p.period?.number) ? p.period.number : null;

  // Baseball labels its own periods ("1st Inning") and we use that verbatim.
  // Football ships no label at all -- just a number and a game clock, and expects
  // the caller to phrase it -- so without this fallback every NFL play would render
  // with an empty "when" column.
  const label =
    p.period?.displayValue ??
    [p.clock?.displayValue || null, ordinal(periodNumber)].filter(Boolean).join(' · ');

  return {
    providerPlayId: String(p.id),
    sequence: Number.isFinite(seq) ? seq : null,
    text: String(p.text),
    awayScore: Number.isFinite(p.awayScore) ? p.awayScore : null,
    homeScore: Number.isFinite(p.homeScore) ? p.homeScore : null,
    scoring: Boolean(p.scoringPlay),
    periodNumber,
    periodLabel: label || null,
    playType: p.type?.text ?? null,
  };
};

/**
 * Pull the play list out of a summary, whichever way this sport happens to ship it.
 *
 * There is no single field, and reading only the flat one is why football and soccer
 * fixtures carried no action log at all: the request succeeded and the array was
 * simply absent, which the empty-is-normal path upstream reads as "no plays yet".
 *
 *   - `plays`      baseball, basketball -- flat and already ordered
 *   - `drives`     football -- nested one level under the current and previous drives
 *   - `commentary` soccer -- each entry wraps a play and carries the sequence that
 *                  the play itself lacks; `keyEvents` is the same feed minus the
 *                  filler, and covers matches with no commentary
 *
 * All four are read on every call rather than switched on the sport: the sport is not
 * in scope here, and a league shipping two of them should yield both. Ids repeated
 * across shapes -- every soccer keyEvent also appears in commentary -- collapse to
 * one row, which is also what the unique index downstream expects.
 */
export function playsFromSummary(data) {
  const seen = new Map();
  const add = (play, opts) => {
    const row = normalisePlay(play, opts);
    if (row && !seen.has(row.providerPlayId)) seen.set(row.providerPlayId, row);
  };

  for (const p of data.plays ?? []) add(p);

  // `drives.current` is one drive and `drives.previous` a list -- and a finished game
  // drops `current` altogether, so neither key can be assumed to be there.
  const drives = data.drives;
  const driveList = Array.isArray(drives)
    ? drives
    : [drives?.current, ...(drives?.previous ?? [])].filter(Boolean);
  for (const drive of driveList) {
    for (const p of drive?.plays ?? []) add(p);
  }

  // Commentary holds the ordering: the play it wraps has an id but no
  // sequenceNumber, so reading keyEvents alone comes back with nothing to sort on.
  for (const entry of data.commentary ?? []) add(entry?.play, { sequence: entry?.sequence });
  for (const p of data.keyEvents ?? []) add(p);

  return [...seen.values()];
}

/** A number ESPN may ship as a string, a float, or not at all. */
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/**
 * A moneyline price, from either of the two places ESPN puts it.
 *
 * The scoreboard and the summary disagree, and reading only one is why the first
 * pass captured a spread and a total for every NFL game and a moneyline for none:
 *
 *   - scoreboard: `odds[].moneyline.home.close.odds`, a STRING ("-185"), with an
 *     `open` beside the `close`
 *   - pickcenter: `odds[].homeTeamOdds.moneyLine`, a NUMBER
 *
 * Close before open, because the closing price is the one the market settled on and
 * the one a recap should quote. Soccer's draw sits under `drawOdds` in pickcenter
 * and under the same `moneyline` map as the two sides on the scoreboard.
 *
 * Prices beyond ±10,000 are dropped. Once a game is over the book's own feed keeps
 * quoting the settled result rather than going quiet -- a finished college football
 * game reads `-100000` for the winner and `+5000` for the loser -- and printing
 * "USC -100000" on a recap is worse than printing no moneyline at all. A real
 * pre-game price never reaches that, so the bound costs nothing live.
 */
const MONEYLINE_LIMIT = 10_000;
function moneyline(book, which) {
  const fromPickcenter =
    which === 'draw' ? book.drawOdds?.moneyLine : book[`${which}TeamOdds`]?.moneyLine;
  const slot = book.moneyline?.[which];
  const value = num(fromPickcenter ?? slot?.close?.odds ?? slot?.open?.odds);
  if (value === null || Math.abs(value) > MONEYLINE_LIMIT) return null;
  return value;
}

/**
 * The betting line on a fixture, from the scoreboard entry we already have.
 *
 * This costs nothing: `competitions[].odds[]` rides along on the same scoreboard
 * response the sweep reads for every league anyway, so capturing it adds no
 * request, no bandwidth and no quota.
 *
 * What it does add is a deadline. **The field only exists while the game is
 * `pre`.** Measured against the live API 2026-09-06: every one of the NFL's 16, the
 * WNBA's 5 and college football's 4 pre-kickoff games carried a line, and every
 * finished game in all four leagues sampled carried `odds: null` -- or, on soccer,
 * the tidier-looking `[null]`, a one-entry list whose entry is nothing, which is
 * why the emptiness check below tests the entries and not the array. A book stops
 * pricing a game when it starts and ESPN drops the field with it.
 *
 * So there is no reading this later for the page that most wants it. The line has
 * to be written down before kickoff and kept, which is what
 * `coalesce(excluded.odds, events.odds)` in upsertEvents is for.
 *
 * Several books are returned, already ordered by ESPN's own `priority`. The first
 * is taken rather than averaged: a consensus of two books at different numbers is a
 * number no one offered, and the page names which book it is quoting.
 */
export function oddsFromCompetition(comp, { state = 'pre', now = new Date() } = {}) {
  const raw = (comp?.odds ?? []).filter(Boolean);
  if (raw.length === 0) return null;
  const book = raw[0];

  const home = book.homeTeamOdds ?? {};
  const away = book.awayTeamOdds ?? {};

  // Which side is favoured, asked of the book rather than inferred from the sign of
  // the spread. The sign convention is not stable across sports -- baseball quotes a
  // run line the other way round from a football spread -- and both sides carry an
  // explicit flag, so there is nothing to infer. A genuine pick'em sets neither.
  const favorite = home.favorite === true ? 'home' : away.favorite === true ? 'away' : null;

  // `details` is the book's own phrasing ("SEA -3.5", "CHC -126") and is what gets
  // shown. It is one string per sport's convention and reassembling it from the
  // parts would mean re-deciding, per sport, something already decided.
  const details = typeof book.details === 'string' && book.details.trim() ? book.details : null;

  const line = {
    provider: book.provider?.name ?? book.provider?.displayName ?? null,
    details,
    spread: num(book.spread),
    overUnder: num(book.overUnder),
    favorite,
    homeMoneyline: moneyline(book, 'home'),
    awayMoneyline: moneyline(book, 'away'),
    // Soccer prices the draw and nothing else does. Absent rather than zero.
    drawMoneyline: moneyline(book, 'draw'),
    capturedAt: now.toISOString(),
    // What the game's state was when this was captured, so the page can say
    // "closing line" only when it has earned it rather than for any stored line.
    capturedState: state,
  };

  // A book entry that is present but says nothing -- no price, no spread, no total
  // -- is worth less than no entry, because storing it would satisfy the coalesce in
  // upsertEvents and lock out the real line arriving on a later pass.
  const hasContent =
    line.details ||
    line.spread !== null ||
    line.overUnder !== null ||
    line.homeMoneyline !== null ||
    line.awayMoneyline !== null;
  return hasContent ? line : null;
}

/**
 * Everything about a finished game that is not a play.
 *
 * This is read out of the same ~500KB summary the play poller already fetches, so
 * like the odds above it costs no additional request. The comment on fetchPlays has
 * described this response as carrying "a boxscore, rosters, odds and news we do not
 * use" since it was written; this is the part that stops being true.
 *
 * Every key is optional and the renderer draws only what it finds. That is not
 * defensive habit -- the shapes genuinely differ per sport, measured 2026-09-06
 * against one finished fixture each:
 *
 *   - `boxscore.teams[].statistics` comes in TWO containers. Football, soccer and
 *     Australian football ship a **flat** list of `{label, displayValue}`. Baseball
 *     and rugby league ship it **grouped**, `{displayName, stats: [...]}` with the
 *     real numbers one level down. Reading only the flat one -- the obvious
 *     shape -- yields an empty comparison table for baseball, which is the same
 *     trap play-by-play hit with `plays` vs `drives` vs `commentary`.
 *   - Volleyball and field hockey ship **no team statistics at all**, but do ship
 *     per-period linescores and player rows. A recap gated on team stats would show
 *     them nothing.
 *   - `leaders` is present for football, soccer and AFL and absent for baseball,
 *     volleyball, rugby league and field hockey.
 *
 * The period label comes from `format.regulation.displayName`, which is the
 * provider naming its own unit -- Quarter, Inning, Half, Set. Worth using rather
 * than hard-coding a per-sport table: play-by-play had to synthesise a label for
 * football because the plays carry none, and this field would have answered it.
 */
export function recapFromSummary(data) {
  if (!data || typeof data !== 'object') return null;

  const comp = data.header?.competitions?.[0];
  const competitors = comp?.competitors ?? [];
  const of = (which) => competitors.find((c) => c.homeAway === which);

  const recap = {};

  /* ---- linescores: the score by quarter, inning, half or set ---- */
  const periodLabel = data.format?.regulation?.displayName ?? null;
  const cells = (c) =>
    (c?.linescores ?? []).map((l) => {
      const v = l.displayValue ?? l.value;
      return v === undefined || v === null ? '' : String(v);
    });
  const regulation = num(data.format?.regulation?.periods);
  const [awayLine, homeLine] = trimPadding(cells(of('away')), cells(of('home')), regulation);
  if (awayLine.length > 0 || homeLine.length > 0) {
    recap.linescores = {
      // Numbered from the provider's own count rather than from `format.periods`:
      // a game that went to extra time or extra innings has more columns than
      // regulation defines, and the header has to grow with the row beneath it.
      labels: Array.from({ length: Math.max(awayLine.length, homeLine.length) }, (_, i) =>
        String(i + 1),
      ),
      periodLabel,
      away: awayLine,
      home: homeLine,
    };
  }

  /* ---- team statistics, out of whichever of the two containers is in use ---- */
  const teamStats = teamStatRows(data.boxscore?.teams ?? []);
  if (teamStats.length > 0) recap.teamStats = teamStats;

  /* ---- who did what, already phrased ---- */
  const leaders = [];
  for (const entry of data.leaders ?? []) {
    const teamId = entry.team?.id ?? null;
    const side =
      teamId && of('home')?.team?.id === teamId
        ? 'home'
        : teamId && of('away')?.team?.id === teamId
          ? 'away'
          : null;
    for (const category of entry.leaders ?? []) {
      const top = (category.leaders ?? [])[0];
      const athlete = top?.athlete;
      if (!athlete || !top?.displayValue) continue;
      leaders.push({
        side,
        team: entry.team?.abbreviation ?? entry.team?.displayName ?? null,
        category: category.shortDisplayName ?? category.displayName ?? null,
        name: athlete.displayName ?? athlete.shortName ?? null,
        // ESPN has already written "25/29, 286 YDS, 2 TD" per sport's convention.
        // Assembling that from raw stats would be re-deciding, badly, something
        // the provider decided correctly for sixteen different sports.
        line: top.displayValue,
      });
    }
  }
  if (leaders.length > 0) recap.leaders = leaders.slice(0, 12);

  /* ---- the frame around the game ---- */
  const info = data.gameInfo ?? {};
  const officials = (info.officials ?? []).map((o) => o.displayName ?? o.fullName).filter(Boolean);
  if (officials.length > 0) recap.officials = officials;
  if (typeof info.gameDuration === 'string' && info.gameDuration)
    recap.duration = info.gameDuration;
  // Zero is how this field says "not reported", not how it says an empty ground.
  // Four of the seven sports sampled return 0 here, and "Attendance 0" under a
  // sold-out AFL final is a worse answer than no attendance line at all.
  if (Number.isFinite(info.attendance) && info.attendance > 0) recap.attendance = info.attendance;

  /* ---- the wire recap, where an agency covers the league ---- */
  const article = data.article;
  if (article?.headline) {
    recap.article = {
      headline: article.headline,
      // The agency's own opening sentence. It arrives with a leading em dash
      // where the dateline was stripped ("— Michael Conforto homered and..."),
      // which reads as a typo on a page that has no dateline to explain it.
      summary:
        typeof article.description === 'string'
          ? article.description.replace(/^[\s—–-]+/, '')
          : null,
      source: article.source ?? null,
      publishedAt: article.published ?? article.originallyPosted ?? null,
    };
  }

  /* ---- the line, if it survived ---- */
  //
  // `summary.odds` is [] on a finished game, same as the scoreboard. `pickcenter`
  // is the one place the number outlives the whistle, and it carries the same
  // fields under the same names -- so it reads with the scoreboard's own parser and
  // gets marked `post`, which is what lets the page call it a closing line.
  const closing = oddsFromCompetition({ odds: data.pickcenter ?? [] }, { state: 'post' });
  if (closing) recap.odds = closing;

  return Object.keys(recap).length > 0 ? recap : null;
}

/**
 * Drop the empty periods some leagues pad a linescore out to.
 *
 * Rugby league is played in two halves and returns four columns, the last two
 * scoreless -- ESPN pads to a fixed width rather than to the shape of the game. Left
 * alone, the recap shows a two-half sport with four numbered periods and invites the
 * reader to wonder what happened in the third.
 *
 * Only ever trailing columns, only ever scoreless ones, and only ever past
 * regulation. Each of those three is load-bearing. A genuine scoreless final quarter
 * inside regulation is a fact about the game and stays; extra time is scored and
 * stays; and a shootout that ends 0-0 on the card cannot be distinguished from
 * padding, which is why regulation is the floor rather than the whole rule. With no
 * regulation count from the provider nothing is trimmed at all.
 */
function trimPadding(away, home, regulationPeriods) {
  if (!regulationPeriods) return [away, home];
  let end = Math.max(away.length, home.length);
  const blank = (row, i) => {
    const v = row[i];
    return v === undefined || v === '' || v === '0';
  };
  while (end > regulationPeriods && blank(away, end - 1) && blank(home, end - 1)) end--;
  return [away.slice(0, end), home.slice(0, end)];
}

/**
 * The team comparison table, from either container ESPN uses.
 *
 * Flat is `[{label, displayValue}]`; grouped is `[{displayName, stats: [...]}]` with
 * the values a level down. Both are read, because which one a league uses is not
 * something the caller knows and is not worth a per-sport table -- the presence of
 * `stats` says it directly.
 *
 * Paired by stat rather than listed per team: the whole value of this table is
 * reading 401 against 312 on one line, and two separate lists make the reader do
 * the join. A stat only one side reported is dropped for the same reason.
 */
function teamStatRows(teams) {
  if (teams.length < 2) return [];
  const side = (which) => teams.find((t) => t.homeAway === which) ?? null;
  const home = side('home');
  const away = side('away');
  if (!home || !away) return [];

  const flatten = (team) => {
    const out = new Map();
    for (const entry of team.statistics ?? []) {
      if (Array.isArray(entry.stats)) {
        // Grouped: the group's name prefixes its stats, because "Hits" under
        // Batting and "Hits" under Pitching are different numbers and collide on
        // the bare label.
        const group = entry.displayName ?? entry.name ?? '';
        for (const s of entry.stats) {
          const label = s.displayName ?? s.shortDisplayName ?? s.abbreviation ?? s.name;
          if (!label) continue;
          out.set(`${group}|${label}`, {
            group,
            label,
            value: s.displayValue ?? (s.value === undefined ? null : String(s.value)),
          });
        }
      } else {
        const label = entry.label ?? entry.displayName ?? entry.name;
        if (!label) continue;
        out.set(`|${label}`, {
          group: null,
          label,
          value: entry.displayValue ?? (entry.value === undefined ? null : String(entry.value)),
        });
      }
    }
    return out;
  };

  const homeStats = flatten(home);
  const awayStats = flatten(away);
  const rows = [];
  for (const [key, h] of homeStats) {
    const a = awayStats.get(key);
    if (!a) continue;
    if (h.value == null && a.value == null) continue;
    if (SKIP_STAT.has(statKey(h.label))) continue;
    // A stat neither side recorded is not a comparison, it is a stat the sport does
    // not use. Rugby league returns the whole of rugby union's card -- lineouts,
    // mauls, rucks -- at 0-0, and baseball returns "Grand Slam Home Runs" for every
    // game ever played. Dropping these is most of the difference between a table
    // worth reading and forty rows of nothing.
    if (isZero(h.value) && isZero(a.value)) continue;
    rows.push({ group: h.group, label: h.label, home: h.value, away: a.value });
  }
  return capPerGroup(rows, 40);
}

/** Compared without punctuation or case, so one denylist covers every sport's phrasing. */
const statKey = (label) =>
  String(label)
    .toLowerCase()
    .replace(/[^a-z]/g, '');

/**
 * Rows that are about the record rather than about the game.
 *
 * A box score answers "what happened", and these do not: they are season context, a
 * projection, or the provider's own bookkeeping about whether a player qualifies for
 * a leaderboard. Left in, they crowd out the actual numbers -- on the MLB fixture
 * sampled they took six of the first thirty rows and "Projected Home Runs 162.0" sat
 * two lines above the batting average.
 */
const SKIP_STAT = new Set(
  [
    'gamesplayed',
    'teamgamesplayed',
    'gamesstarted',
    'qualified',
    'qualifiedcatcher',
    'isqualified',
    'isqualifiedinsteals',
    'isqualifiedsteals',
    'playerrating',
    'projectedhomeruns',
    'rank',
  ].map(statKey),
);

/** Whether a stat reads as nothing: absent, blank, or any spelling of zero. */
const isZero = (v) => {
  if (v === null || v === undefined || v === '') return true;
  const n = Number(String(v).replace(/[%,]/g, ''));
  return Number.isFinite(n) && n === 0;
};

/**
 * Cap the table, taking from every group rather than filling it from the first.
 *
 * Grouped sports return several hundred rows and a recap is not a statistics export,
 * so there has to be a cap -- but a flat `slice` puts the whole of it inside
 * whichever group ESPN happened to order first. On the MLB fixture that meant forty
 * rows of Batting and not one line of Pitching or Fielding, which is a strange thing
 * for a baseball box score to omit. Round-robin instead: every group gets a row
 * before any group gets a second, so the shape of the table follows the shape of the
 * sport. Ungrouped sports have one bucket and are unaffected.
 */
function capPerGroup(rows, limit) {
  if (rows.length <= limit) return rows;
  const groups = new Map();
  for (const row of rows) {
    const g = row.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(row);
  }
  const out = [];
  const buckets = [...groups.values()];
  for (let i = 0; out.length < limit; i++) {
    let placed = false;
    for (const bucket of buckets) {
      if (i >= bucket.length) continue;
      out.push(bucket[i]);
      placed = true;
      if (out.length === limit) break;
    }
    if (!placed) break;
  }
  return out;
}

/**
 * Play-by-play for one fixture.
 *
 * The summary response is ~500KB and carries rosters and news we do not use, so
 * callers must space these out -- see eventsNeedingPlays, which caps and staggers
 * them. There is no smaller endpoint.
 *
 * The provider phrases each play per sport and supplies its own stable id, so both
 * are passed through: rebuilding "Duran homered to right center (388 feet)" from
 * structured fields is not something we could do better.
 */
export async function fetchPlays(providerKey, eventProviderKey) {
  const summary = await fetchSummary(providerKey, eventProviderKey);
  return summary ? playsFromSummary(summary) : [];
}

/**
 * The plays AND the recap, from a single read.
 *
 * The whole point of this function's existence is that it is one request. Splitting
 * plays and box score into two adapter calls would have doubled the app's largest
 * bandwidth line -- ~500KB per fixture through a metered residential proxy, at 8
 * summaries per two minutes -- to fetch two halves of one response we already had.
 *
 * The recap is parsed only when asked for, since it is wasted work on a game still
 * in progress: the box score is not final, and the poller will be back.
 */
export async function fetchPlaysAndRecap(providerKey, eventProviderKey, { recap = false } = {}) {
  const summary = await fetchSummary(providerKey, eventProviderKey);
  if (!summary) return { plays: [], recap: null };
  return {
    plays: playsFromSummary(summary),
    recap: recap ? recapFromSummary(summary) : null,
  };
}

async function fetchSummary(providerKey, eventProviderKey) {
  // The event's provider_key is `<sport>/<league>/<id>`; the summary wants the id.
  const eventId = eventProviderKey.split('/').pop();
  if (!eventId) return null;

  try {
    return await getJson(`${SITE}/${providerKey}/summary?event=${encodeURIComponent(eventId)}`);
  } catch {
    // A fixture with no summary yet is normal before first pitch, not an error.
    return null;
  }
}

/** ESPN's status states are already pre/in/post; anything unknown is treated as pre. */
function normaliseState(competition) {
  const state = competition?.status?.type?.state;
  return state === 'in' || state === 'post' ? state : 'pre';
}

const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * Fixtures for one league across a date window.
 *
 * ESPN answers a whole range in a single request, so a 14-day horizon costs one
 * call per league rather than fourteen. When a response comes back at the cap the
 * window is split and re-fetched, because a truncated response is indistinguishable
 * from a quiet fortnight and would silently drop half a busy league's schedule.
 */
export async function fetchSchedule({ providerKey, from, to, depth = 0 }) {
  const url = `${SITE}/${providerKey}/scoreboard?dates=${yyyymmdd(from)}-${yyyymmdd(to)}&limit=1000`;

  let data;
  try {
    data = await getJson(url);
  } catch (err) {
    // A 404 on a date window means nothing is scheduled inside it, which is the
    // normal state of most leagues most of the year -- in August, college
    // basketball, the NFL regular season and half of Europe are all "missing".
    // The undated scoreboard answers with the NEXT fixtures instead, so an
    // out-of-season league shows its season opener rather than an empty page.
    //
    // Only at the top level: inside the window-splitting recursion a 404 means
    // that half genuinely has nothing, and refetching undated there would drag
    // the same far-future fixtures into every branch.
    if (depth > 0) throw err;
    data = await getJson(`${SITE}/${providerKey}/scoreboard`);
  }

  const events = data.events ?? [];

  // The scoreboard carries the league's real display name, abbreviation and logos.
  // The catalogue endpoint only exposes the slug, so without this a league is
  // called "eng.1" everywhere instead of "English Premier League" -- and it costs
  // nothing, because this response was being fetched anyway.
  const meta = data.leagues?.[0];
  const league = meta
    ? {
        name: meta.name ?? null,
        abbreviation: meta.abbreviation ?? null,
        logoUrl: meta.logos?.[0]?.href ?? null,
      }
    : null;

  // Only worth splitting a window that is at least two days wide. Below that the
  // halves collapse to the same day and `mid + 1 day` lands past `to`, which
  // renders as a backwards range like `dates=20260831-20260830` -- ESPN answers
  // that with a 400, so the split turned a full page into a failed league.
  const spansMultipleDays = to.getTime() - from.getTime() >= 2 * 86400000;

  if (events.length >= PAGE_CAP && depth < 4 && spansMultipleDays) {
    const mid = new Date((from.getTime() + to.getTime()) / 2);
    const dayAfterMid = new Date(mid.getTime() + 86400000);
    if (mid > from && dayAfterMid <= to) {
      const [a, b] = await Promise.all([
        fetchSchedule({ providerKey, from, to: mid, depth: depth + 1 }),
        fetchSchedule({ providerKey, from: dayAfterMid, to, depth: depth + 1 }),
      ]);
      const seen = new Set();
      return {
        league: league ?? a.league ?? b.league,
        events: [...a.events, ...b.events].filter(
          (e) => !seen.has(e.providerKey) && seen.add(e.providerKey),
        ),
      };
    }
  }

  return { league, events: events.flatMap((e) => normaliseEntry(e, providerKey)) };
}

function normaliseEvent(e, providerKey) {
  const comp = e.competitions?.[0];
  if (!comp || !e.date) return null;

  const competitors = comp.competitors ?? [];
  const side = (which) => {
    const c = competitors.find((x) => x.homeAway === which);
    if (!c?.team) return null;
    const t = c.team;
    return {
      // Same league scoping as fetchTeams -- these must agree or a fixture's teams
      // will not resolve to the rows the roster created.
      providerKey: `${providerKey}/${t.id}`,
      name: t.name ?? t.displayName ?? t.shortDisplayName ?? 'Unknown',
      displayName: t.displayName ?? t.name ?? 'Unknown',
      abbreviation: t.abbreviation ?? null,
      logoUrl: t.logo ?? t.logos?.[0]?.href ?? null,
      score: c.score === undefined ? null : Number.parseInt(c.score, 10),
      // The first record is the overall season one; later entries are splits
      // (home/away, conference) that mean nothing without their labels.
      record: c.records?.[0]?.summary ?? null,
    };
  };

  const home = side('home');
  const away = side('away');

  // Broadcasters come grouped by market (national / home / away). Flattened and
  // de-duplicated, because "MLB.TV, Tigers.TV" is what a viewer wants to read.
  //
  // Kept as a list as well as a string. The joined form is what the feeds and the
  // legacy column want; the list is what the market picker needs, and splitting the
  // string back apart would be guessing that no broadcaster has a comma in its name.
  //
  // Spelled out on the way in rather than on the way to the page, so the RSS item,
  // the calendar entry and the API say the same thing the page does. ESPN writes
  // "NBC Sports CA" because the field is about thirteen characters wide; the channel
  // calls itself NBC Sports California and so does a reader's remote. Deduplicated
  // afterwards, since two truncations can spell out to one name.
  const broadcastNames = [
    ...new Set((comp.broadcasts ?? []).flatMap((b) => b.names ?? []).map(canonicalBroadcaster)),
  ];
  const broadcast = broadcastNames.join(', ') || null;

  const state = normaliseState(comp);

  return {
    providerKey: `${providerKey}/${e.id}`,
    startsAt: new Date(e.date),
    state,
    // Free -- it rides on this same response -- and it has to be taken here or not
    // at all, because the field is gone by the time the game is worth reading about.
    // See oddsFromCompetition; null on most passes, which is why the upsert
    // coalesces rather than assigns.
    odds: oddsFromCompetition(comp, { state }),
    statusDetail: comp.status?.type?.shortDetail ?? null,
    name: e.name ?? e.shortName ?? 'Fixture',
    shortName: e.shortName ?? null,
    venue: comp.venue?.fullName ?? null,
    venueCity: comp.venue?.address?.city ?? null,
    // US venues carry a state, everywhere else a country, and never both. One
    // field, because two would leave whichever does not apply permanently null.
    venueRegion: comp.venue?.address?.state ?? comp.venue?.address?.country ?? null,
    // Absent on most leagues and null on soccer, so anything but true is false.
    neutralSite: comp.neutralSite === true,
    broadcast,
    broadcastNames,
    attendance: Number.isFinite(comp.attendance) ? comp.attendance : null,
    period: Number.isFinite(e.status?.period) ? e.status.period : null,
    displayClock: e.status?.displayClock ?? null,
    home,
    away,
    homeScore: Number.isFinite(home?.score) ? home.score : null,
    awayScore: Number.isFinite(away?.score) ? away.score : null,
    homeRecord: home?.record ?? null,
    awayRecord: away?.record ?? null,
  };
}

/**
 * An unfilled bracket slot.
 *
 * A draw is published before it is drawn, so a tournament that has not started
 * carries its full bracket with both sides named "TBD" and a placeholder time at
 * midnight local. Storing those would invent hundreds of "TBD v TBD" fixtures and,
 * worse, a player called TBD that people could follow. The provider marks them with
 * a negative id, which is the one signal here that does not depend on wording.
 */
const isUndrawn = (c) =>
  Number(c?.id) < 0 || (c?.athlete?.displayName ?? c?.roster?.displayName) === 'TBD';

/**
 * One side of a tennis match: a player, or a doubles pair.
 *
 * Singles put the person on `athlete`; doubles put the pairing on `roster` with a
 * composite id ("1652-3970") and both names in one string. Either way it is one
 * side with one key, so a pair is followed as a unit -- which is what a doubles
 * fixture means. The flag stands in for a crest: tennis has no club badge, and a
 * row with no image at all reads as broken rather than as neutral.
 */
/** The carriers of one tennis match, spelled out and de-duplicated. */
const tennisBroadcasters = (m) => [
  ...new Set((m.broadcasts ?? []).flatMap((b) => b.names ?? []).map(canonicalBroadcaster)),
];

const tennisSide = (c, providerKey) => {
  if (!c || isUndrawn(c)) return null;
  const name = c.athlete?.displayName ?? c.roster?.displayName;
  if (!name) return null;

  return {
    providerKey: `${providerKey}/${c.id}`,
    name,
    displayName: name,
    abbreviation: c.athlete?.shortName ?? c.roster?.shortDisplayName ?? null,
    logoUrl: c.athlete?.flag?.href ?? c.roster?.athletes?.[0]?.flag?.href ?? null,
    // Sets won, because that is the score a tennis result is quoted in -- the
    // linescores are games per set, and their sum is not a scoreline anyone uses.
    score: (c.linescores ?? []).length ? c.linescores.filter((l) => l.winner).length : null,
    record: null,
  };
};

/**
 * Tennis, where a scoreboard "event" is a fortnight rather than a fixture.
 *
 * The tournament is the event and the matches hang off it in `groupings`, one per
 * draw -- mens-singles, womens-doubles, and so on. Read as a team sport it has no
 * `competitions` at all, so every tournament normalised to null and the whole sport
 * stored nothing: two leagues, no players, "No fixtures scheduled" all season.
 *
 * Flattened to one event per match it behaves like everything else: real start
 * times, real opponents, and players that become followable teams through the same
 * path that covers leagues whose roster endpoint 404s. The tournament name goes in
 * `venue` -- for tennis the tournament genuinely is the place, and a match listed
 * without it is unplaceable.
 */
/**
 * Which tour owns a draw.
 *
 * A combined tournament -- Cincinnati, the US Open -- is returned in full by BOTH
 * tour scoreboards, every draw included, so taking each at face value stores every
 * match twice under two different keys and invents a second copy of each player.
 * Tours that do not overlap are already separate: Winston-Salem appears only on the
 * ATP board, the Philly Open only on the WTA one.
 *
 * Mixed doubles names no tour and belongs to both, which is the one case with no
 * right answer. It goes to the ATP so that it lands exactly once; the alternative
 * is the same fifteen slam fixtures listed twice.
 */
const drawBelongsTo = (slug, tour) => {
  if (!slug || (tour !== 'atp' && tour !== 'wta')) return true;
  if (slug.startsWith('womens')) return tour === 'wta';
  return tour === 'atp';
};

function tennisMatches(tournament, providerKey) {
  const out = [];
  const tour = providerKey.split('/').pop();

  for (const draw of tournament.groupings ?? []) {
    if (!drawBelongsTo(draw.grouping?.slug, tour)) continue;
    for (const m of draw.competitions ?? []) {
      if (!m?.id || !m.date) continue;

      const competitors = m.competitors ?? [];
      // homeAway is present on some draws and absent on others; `order` is always
      // there, and 1/2 line up with home/away wherever both appear.
      const pick = (which, ord) =>
        competitors.find((x) => x.homeAway === which) ?? competitors.find((x) => x.order === ord);
      const home = tennisSide(pick('home', 1), providerKey);
      const away = tennisSide(pick('away', 2), providerKey);
      if (!home || !away) continue;

      out.push({
        providerKey: `${providerKey}/${m.id}`,
        startsAt: new Date(m.date),
        state: normaliseState(m),
        statusDetail: m.status?.type?.shortDetail ?? null,
        name: `${away.name} v ${home.name}`,
        shortName:
          away.abbreviation && home.abbreviation
            ? `${away.abbreviation} v ${home.abbreviation}`
            : null,
        venue: tournament.name ?? tournament.shortName ?? null,
        venueCity: [m.venue?.fullName, m.venue?.court].filter(Boolean).join(' · ') || null,
        venueRegion: null,
        // Neither side is at home, which the UI already knows how to render: no
        // home/away tags, and "vs" rather than "at".
        neutralSite: true,
        broadcast: tennisBroadcasters(m).join(', ') || null,
        broadcastNames: tennisBroadcasters(m),
        attendance: null,
        period: Number.isFinite(m.status?.period) ? m.status.period : null,
        displayClock: null,
        home,
        away,
        homeScore: home.score,
        awayScore: away.score,
        homeRecord: null,
        awayRecord: null,
      });
    }
  }

  return out;
}

/**
 * The tournament itself, alongside its matches.
 *
 * A draw is only published a few days out, so a tournament that has not been drawn
 * fans out to nothing -- which left the US Open invisible a week before it started,
 * inside the horizon and with a date, simply because none of its matches had names
 * yet. The tournament is a fixture in its own right: it is the thing someone wants
 * in their calendar before the draw exists, and it is the same shape as a grand prix
 * or a fight card, which this adapter already stores with no competitors at all.
 *
 * A combined tournament lands once per tour. That is two rows for one fortnight, but
 * they sit in different leagues, and an ATP follower looking at the ATP calendar
 * should see it there.
 */
function tennisTournament(t, providerKey) {
  if (!t?.id || !t.date) return null;

  return {
    providerKey: `${providerKey}/${t.id}`,
    startsAt: new Date(t.date),
    state: normaliseState(t),
    statusDetail: t.status?.type?.shortDetail ?? null,
    name: t.name ?? t.shortName ?? 'Tournament',
    shortName: t.shortName ?? null,
    venue: t.venue?.displayName ?? null,
    venueCity: null,
    venueRegion: null,
    neutralSite: true,
    broadcast: null,
    broadcastNames: [],
    attendance: null,
    period: null,
    displayClock: null,
    home: null,
    away: null,
    homeScore: null,
    awayScore: null,
    homeRecord: null,
    awayRecord: null,
  };
}

/**
 * One scoreboard entry -> the fixtures it represents, which is usually itself.
 *
 * Tennis is the exception: its entry is a tournament holding a fortnight of
 * matches, so it fans out into both the tournament and every match in it.
 */
function normaliseEntry(e, providerKey) {
  if (Array.isArray(e?.groupings) && e.groupings.length > 0) {
    const tournament = tennisTournament(e, providerKey);
    return [...(tournament ? [tournament] : []), ...tennisMatches(e, providerKey)];
  }
  const one = normaliseEvent(e, providerKey);
  return one ? [one] : [];
}
