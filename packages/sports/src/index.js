import { brand, config } from '@tipoff/config';
import * as q from '@tipoff/db/queries';
import { CATALOG_ADAPTERS, ingest } from './catalog.js';
import * as espn from './espn.js';
import { regionFor } from './regions.js';
import { normaliseTitle } from './slug.js';
import * as sportsdb from './sportsdb.js';

/**
 * Re-exported rather than reached for by subpath: this package publishes a single
 * entry point, and importing '@tipoff/sports/m3u' resolves only by accident of the
 * linker until package.json says otherwise. The web app uses both of these.
 */
export {
  channelMatchesFixture,
  channelMatchesName,
  channelsForFixture,
  entryKind,
  groupsOf,
  isPlaceholder,
  MAX_CHANNELS,
  marketsWithOwnChannels,
  matchTerms,
  oneChannelM3u,
  parseM3u,
  rankChannelsForFixture,
} from './m3u.js';
export { normaliseTitle, slugify } from './slug.js';
export { normaliseTeam } from './sportsdb.js';

/**
 * One box, every kind of row.
 *
 * The site had a search that looked in exactly one table -- teams -- and it was
 * reachable only as the follow picker's autocomplete. That is the right answer for
 * a picker and the wrong one for a box in the header, where whatever somebody
 * types is whatever they were just looking at: a competition they saw on a chip,
 * a cup final with a name of its own, a channel in their own list, a person.
 *
 * Five sources, run together and each allowed to fail on its own. A search box
 * must not go blank because one query was slow or one table was locked, so a
 * rejected source contributes nothing and the rest of the page still renders.
 *
 * Nothing here reaches a provider. Every other search-shaped thing on the sibling
 * brand falls through to TMDB when the local answer is thin; there is no
 * equivalent for fixtures, because ESPN has no search endpoint and the catalogue
 * is already complete rather than a popular subset.
 *
 * @param {string} term
 * @param {{userId?: string|null, sport?: string|null, limit?: number}} [opts]
 */
export async function searchEverything(term, { userId = null, sport = null, limit = 20 } = {}) {
  const clean = String(term ?? '').trim();
  const empty = { term: clean, teams: [], leagues: [], events: [], channels: [], people: [] };
  if (clean.length < 2) return { ...empty, total: 0 };

  const settled = await Promise.allSettled([
    q.searchTeamsFull(clean, { limit, sport }),
    q.searchLeagues(clean, { sport }),
    q.searchFixtures(clean, { sport }),
    // The needle goes through the same normaliser that wrote norm_title at import.
    // Passing the raw term instead silently matches nothing the moment a channel
    // name has a colon or a bracketed quality tag in it, which is most of them.
    q.searchOwnChannels(userId, { normTerm: normaliseTitle(clean) }),
    // People are not a category of fixture, so narrowing to a sport must not hide
    // them: that filter narrows the catalogue, not the site.
    sport ? Promise.resolve([]) : q.searchPeople(clean, { viewerId: userId }),
  ]);

  const [teams, leagues, events, channels, people] = settled.map((s) =>
    s.status === 'fulfilled' ? (s.value ?? []) : [],
  );

  return {
    term: clean,
    teams,
    leagues,
    events,
    channels,
    people,
    total: teams.length + leagues.length + events.length + channels.length + people.length,
  };
}

const ADAPTERS = { espn };

export function adapters() {
  return config.sports.providers.map((n) => {
    const a = ADAPTERS[n];
    if (!a)
      throw new Error(`Unknown sports provider "${n}". Known: ${Object.keys(ADAPTERS).join(', ')}`);
    return a;
  });
}

/** Refresh the league catalogue. Cheap, and how new competitions appear without a deploy. */
export async function syncCatalogue({ log = console.log } = {}) {
  let n = 0;
  for (const adapter of adapters()) {
    const leagues = await adapter.listLeagues();
    for (const league of leagues) {
      await q.upsertLeague(league);
      n++;
    }
    log(`[sync] ${adapter.name}: ${leagues.length} leagues`);
  }

  const regions = await backfillLeagueRegions({ log });
  const { ambiguous } = await q.recomputeAbbrAmbiguity();
  log(
    `[sync] regions: ${regions.resolved}/${regions.checked} resolved, ${ambiguous} ambiguous abbreviations`,
  );
  return n;
}

/**
 * Fill in where each league is played, a few at a time.
 *
 * Deliberately incremental. The country is only on ESPN's per-league endpoint --
 * not on the scoreboard, which is fetched anyway -- so resolving the whole
 * catalogue at once would put 354 extra requests through metered residential
 * bandwidth every night to learn something that never changes. Forty a run
 * drains the backlog inside a week and then costs nothing, because a resolved
 * league stops being selected.
 *
 * The curated table wins over the provider: see regions.js for why, and for the
 * one that prompted all of this (Australia's NBL reading as the NBA).
 *
 * Never throws. A region is decoration on a chip, and a decoration must not be
 * able to fail the sync that carries the fixtures.
 */
export async function backfillLeagueRegions({ log = console.log, limit = 40 } = {}) {
  let checked = 0;
  let resolved = 0;
  try {
    const due = await q.leaguesMissingRegion({ limit });
    for (const league of due) {
      checked++;
      const curated = regionFor(league.provider_key, null);
      // A curated answer is already known, so it costs no request at all.
      const region =
        curated ??
        (league.provider === 'espn' ? await espn.fetchLeagueRegion(league.provider_key) : null);
      // Written unconditionally, including when the answer is null: the write is
      // what stamps region_checked_at, and without that stamp the sweep re-asks
      // the same unresolvable leagues forever and never reaches the rest.
      await q.setLeagueRegion(league.id, region);
      if (region) resolved++;
    }
  } catch (err) {
    log(`[sync] region backfill stopped: ${err?.message ?? err}`);
  }
  return { checked, resolved };
}

/**
 * Pull fixtures for one league and persist them.
 *
 * Teams are upserted first and mapped provider_key -> id, because an event row needs
 * real foreign keys. Doing it per league (rather than globally) keeps the working set
 * small enough that the whole league lands in one transaction-sized batch.
 */
export async function syncLeague(
  league,
  {
    horizonDays = config.sports.horizonDays,
    backfillDays = config.sports.backfillDays,
    /**
     * Fetch the roster as well as the schedule.
     *
     * Off for the near-window refresh, and it halves that pass: a league costs two
     * upstream requests here, and the roster is the half that does not change
     * between now and tonight. Turning it off also means this must NOT stamp
     * rosters_synced_at -- see below.
     */
    roster: wantRoster = true,
  } = {},
) {
  const adapter = ADAPTERS[league.provider];
  if (!adapter) throw new Error(`No adapter for provider ${league.provider}`);

  // Six hours back is all the calendar needs -- enough to close out whatever was in
  // progress at the last pass. It is also the reason a widened play catch-up window
  // finds nothing to do: a fixture that was never fetched was never stored, and the
  // catch-up window only ranks rows that already exist. backfillDays reaches back
  // for the fixtures themselves; max() keeps the six-hour floor, so the default of
  // zero is the old behaviour exactly and this can only ever widen.
  const backMs = Math.max(6 * 3600_000, backfillDays * 86_400_000);
  const from = new Date(Date.now() - backMs);
  const to = new Date(Date.now() + horizonDays * 86_400_000);

  // Roster and fixtures are fetched independently on purpose.
  //
  // Promise.all here meant a failing schedule threw away a perfectly good roster,
  // so an out-of-season league ended up with no fixtures AND no teams -- a blank
  // page for most of the catalogue for most of the year. They are different
  // questions and one failing should not erase the other's answer.
  const [scheduleResult, rosterResult] = await Promise.allSettled([
    adapter.fetchSchedule({ providerKey: league.provider_key, from, to }),
    wantRoster && adapter.fetchTeams
      ? adapter.fetchTeams(league.provider_key)
      : Promise.resolve([]),
  ]);

  const roster = rosterResult.status === 'fulfilled' ? rosterResult.value : [];
  const meta = scheduleResult.status === 'fulfilled' ? scheduleResult.value.league : null;
  const fixtures = scheduleResult.status === 'fulfilled' ? scheduleResult.value.events : [];

  // Only a league that gave us neither is a failure worth reporting.
  if (scheduleResult.status === 'rejected' && roster.length === 0) {
    throw scheduleResult.reason;
  }

  // Upgrade the row from the slug the catalogue gave us to the real display name.
  if (meta?.name && meta.name !== league.name) {
    await q.renameLeague({
      id: league.id,
      name: meta.name,
      abbreviation: meta.abbreviation,
      logoUrl: meta.logoUrl,
    });
  }

  // Seed from the roster first, so a club with no fixture this fortnight still
  // appears in the picker. Fixture participants are merged in below, which also
  // covers leagues whose teams endpoint 404s.
  const teamRows = new Map();
  for (const t of roster) {
    teamRows.set(t.providerKey, {
      provider: league.provider,
      provider_key: t.providerKey,
      league_id: league.id,
      slug: `${league.slug}-${t.providerKey.split('/').pop()}`,
      name: t.name,
      display_name: t.displayName,
      abbreviation: t.abbreviation,
      logo_url: t.logoUrl,
    });
  }

  if (fixtures.length === 0) {
    if (teamRows.size > 0) {
      const onlyRoster = await q.upsertTeams([...teamRows.values()]);
      await q.linkTeamsToLeague(
        onlyRoster.map((r) => r.id),
        league.id,
      );
    }
    // Gated for the same reason as the stamp at the end of this function, and this
    // is the path the near pass takes MOST often: a league with a game tonight but
    // nothing else inside a two-day window comes back empty here. Stamping from
    // here would mark the whole catalogue freshly swept every three hours.
    if (wantRoster) await q.markRostersSynced(league.id);
    return { events: 0, teams: teamRows.size };
  }

  // A league sends the same clubs on every fixture, so deduplicate before writing.
  for (const f of fixtures) {
    for (const t of [f.home, f.away]) {
      if (t && !teamRows.has(t.providerKey)) {
        teamRows.set(t.providerKey, {
          provider: league.provider,
          provider_key: t.providerKey,
          league_id: league.id,
          slug: `${league.slug}-${t.providerKey.split('/').pop()}`,
          name: t.name,
          display_name: t.displayName,
          abbreviation: t.abbreviation,
          logo_url: t.logoUrl,
        });
      }
    }
  }

  const saved = await q.upsertTeams([...teamRows.values()]);
  const teamId = new Map(saved.map((r) => [r.provider_key, r.id]));

  // Record the membership edge rather than stamping a single league onto the team.
  // A club plays in its league, its cup and often a continental competition; the old
  // single column meant whichever swept last owned the club and every other league
  // page lost it.
  await q.linkTeamsToLeague(
    saved.map((r) => r.id),
    league.id,
  );

  const eventRows = fixtures.map((f) => ({
    provider: league.provider,
    provider_key: f.providerKey,
    league_id: league.id,
    starts_at: f.startsAt,
    state: f.state,
    status_detail: f.statusDetail,
    name: f.name,
    short_name: f.shortName,
    venue: f.venue,
    venue_city: f.venueCity,
    venue_region: f.venueRegion,
    neutral_site: f.neutralSite,
    broadcast: f.broadcast,
    // Stamped on the row itself, not only in the ON CONFLICT clause: a fixture
    // seen for the first time takes the INSERT path, and without these it would
    // arrive holding an ESPN listing labelled as coming from nowhere.
    broadcast_source: f.broadcast ? 'espn' : null,
    broadcast_country: f.broadcast ? 'United States' : null,
    broadcast_markets: f.broadcastNames?.length
      ? JSON.stringify([{ country: 'United States', channels: f.broadcastNames }])
      : null,
    attendance: f.attendance,
    period: f.period,
    display_clock: f.displayClock,
    home_record: f.homeRecord,
    away_record: f.awayRecord,
    home_team_id: f.home ? (teamId.get(f.home.providerKey) ?? null) : null,
    away_team_id: f.away ? (teamId.get(f.away.providerKey) ?? null) : null,
    home_score: f.homeScore,
    away_score: f.awayScore,
  }));

  await q.upsertEvents(eventRows);

  // ONLY when the roster was actually fetched. rosters_synced_at is what the boot
  // check reads to decide whether the full sweep is overdue, so stamping it from a
  // partial refresh would make the catalogue look freshly swept forever -- the
  // exact failure that froze the sweep for months when the reading was taken from
  // events.updated_at, reached from a different direction.
  if (wantRoster) await q.markRostersSynced(league.id);

  return { events: eventRows.length, teams: teamRows.size };
}

/**
 * Refresh scores for one league, and nothing else.
 *
 * The full sync also pulls the roster and a fortnight of fixtures, which is far too
 * much to repeat every minute. This asks only for today and writes only what
 * changes during a game: state, status detail and the two scores.
 */
export async function syncLeagueScores(league) {
  const adapter = ADAPTERS[league.provider];
  if (!adapter) return { events: 0 };

  const now = new Date();
  const { events: fixtures } = await adapter.fetchSchedule({
    providerKey: league.provider_key,
    from: new Date(now.getTime() - 12 * 3600_000),
    to: new Date(now.getTime() + 12 * 3600_000),
  });
  if (fixtures.length === 0) return { events: 0 };

  await q.updateEventScores(
    fixtures.map((f) => ({
      provider: league.provider,
      provider_key: f.providerKey,
      state: f.state,
      status_detail: f.statusDetail,
      home_score: f.homeScore,
      away_score: f.awayScore,
      period: f.period,
      display_clock: f.displayClock,
      attendance: f.attendance,
      broadcast: f.broadcast,
      markets: f.broadcastNames?.length
        ? [{ country: 'United States', channels: f.broadcastNames }]
        : [],
    })),
  );
  return { events: fixtures.length };
}

/**
 * The live tick: refresh scores for whatever is actually being played.
 *
 * Costs one request per league with a game on, which is a handful even on a busy
 * evening -- the whole point of scoping it rather than re-running the full sweep.
 */
export async function syncLiveScores({ log = console.log } = {}) {
  const leagues = await q.leaguesWithLiveGames();
  if (leagues.length === 0) return { leagues: 0, events: 0 };

  let events = 0;
  let failed = 0;
  await Promise.all(
    leagues.map(async (league) => {
      try {
        const r = await syncLeagueScores(league);
        events += r.events;
      } catch (err) {
        // A provider blip must not stop the other leagues' scores updating -- but
        // say why. Swallowing this silently is how "6 failed" sat in the log for
        // two hours without anyone being able to tell it was an upstream block.
        failed++;
        if (failed === 1) log(`[live] first failure: ${err?.message ?? err}`);
      }
    }),
  );
  log(`[live] ${leagues.length} league(s), ${events} fixtures refreshed, ${failed} failed`);
  return { leagues: leagues.length, events, failed };
}

/**
 * Pull play-by-play for games in progress.
 *
 * Runs on its own slower cadence rather than with the score tick. A summary is
 * ~500KB against a scoreboard's few KB, and every one goes through the metered
 * proxy, so this is capped and staggered: oldest-refreshed first, a handful at a
 * time. Scores stay minute-fresh; the action log trails by a couple of minutes,
 * which is the right trade for the bandwidth.
 *
 * The quota is split rather than pooled. A game being played needs reading again
 * and again while it is on; a finished one needs reading exactly once more, for the
 * end of it. Drawn from one queue the finished games win on age alone -- 252 of them
 * held every slot for an hour while the fixtures someone had open got nothing -- so
 * live games take the bulk and the catch-up reads get what is left. Both keep
 * moving, and neither can shut the other out.
 */
export async function syncPlays({ log = console.log, limit = 8 } = {}) {
  // A reserved share for the catch-up reads, but only while there is live work to
  // reserve it against. The live queue is drawn against the whole cap and handed
  // back down to its share only if it is actually big enough to need capping, so
  // neither queue can starve the other and neither leaves a slot idle: an evening
  // with nothing on drains the backlog at full rate, and a busy one still closes
  // out a couple of finished games per tick.
  const endedShare = Math.min(2, Math.max(1, limit - 1));
  const catchupHours = config.sports.playsCatchupHours;
  const liveAll = await q.eventsNeedingPlays({ staleSeconds: 120, limit, state: 'in' });
  // Capped only when there is enough live work to cap: a shorter list passes
  // through whole and leaves the remainder to the catch-up queue.
  const live = liveAll.slice(0, limit - endedShare);
  const ended = await q.eventsNeedingPlays({
    staleSeconds: 120,
    limit: limit - live.length,
    state: 'post',
    catchupHours,
  });
  const due = [...live, ...ended];
  if (due.length === 0) return { events: 0, plays: 0 };

  let inserted = 0;
  let failed = 0;

  // A finished game is done with for good; a live one is only done with for now.
  const close = (event) =>
    event.state === 'post' ? q.markPlaysFinal(event.id) : q.markPlaysSynced(event.id);

  for (const event of due) {
    try {
      const adapter = ADAPTERS[event.provider];
      // Stamped rather than skipped. An unstamped row stays at the front of the
      // queue for ever, so a handful of fixtures from a provider that cannot do
      // play-by-play would hold the whole cap and nothing else would be read again.
      if (!adapter?.fetchPlays) {
        await close(event);
        continue;
      }

      const plays = await adapter.fetchPlays(event.league_key, event.provider_key);
      if (plays.length > 0) {
        const rows = plays.map((p) => ({
          event_id: event.id,
          provider_play_id: p.providerPlayId,
          sequence: p.sequence,
          text: p.text,
          away_score: p.awayScore,
          home_score: p.homeScore,
          scoring: p.scoring,
          period_number: p.periodNumber,
          period_label: p.periodLabel,
          play_type: p.playType,
        }));
        const added = await q.insertPlays(rows);
        inserted += added.length;
      }
      // Stamped even when empty, so a fixture with no summary is not retried on
      // every single tick ahead of games that actually have one.
      await close(event);
    } catch (err) {
      failed++;
      if (failed === 1) log(`[plays] first failure: ${err?.message ?? err}`);
      // Only the timestamp on the failure path, never the final flag: a transient
      // upstream blip must not be what decides a finished game has no recap. The
      // stamp alone sends it to the back of the queue, so it retries without
      // holding a slot.
      await q.markPlaysSynced(event.id).catch(() => {});
    }
  }

  // Say how many are waiting, not just how many were read, and keep the two queues
  // apart in the log. Reading 8 of 8 and reading 8 of 400 print identically
  // otherwise, and the second one means a live fixture is an hour from its first
  // play -- which is exactly how this went unnoticed.
  // From the uncapped draw, so the number is the real live backlog rather than
  // whatever this tick's share happened to be.
  const liveDue = liveAll[0]?.total_due ?? liveAll.length;
  const endedDue = ended[0]?.total_due ?? ended.length;
  log(
    `[plays] live ${live.length}/${liveDue}, ended ${ended.length}/${endedDue}, ` +
      `${inserted} new, ${failed} failed`,
  );
  return { events: due.length, plays: inserted, failed, liveDue, endedDue };
}

/** Upper bound on TheSportsDB requests in a single pass. */
const BROADCAST_REQUEST_CAP = 240;

/**
 * Fill in broadcast listings ESPN does not have.
 *
 * ESPN's scoreboard is US-only and partial even there -- measured 2026-08-21, the
 * NFL was 16/16 while the AFL was 0/9, the NHL 0/7 and the Premier League had
 * nothing beyond the current week. Anything still missing after the sweep is
 * offered to TheSportsDB, which carries non-US broadcasters (the AFL fixture that
 * prompted this comes back "7 Queensland / Australia").
 *
 * Runs at the tail of the sweep rather than on a repeatable of its own. That keeps
 * it downstream of freshly-written fixtures, and avoids adding another timer to
 * reset on boot -- the failure that quietly froze the fixture sweep for months.
 *
 * Listings are fetched per (sport, day) and cached for the run, because one request
 * answers every fixture in that bucket. Each event is matched against its own UTC
 * day AND the day before: the two providers disagree about which calendar day a
 * late kickoff belongs to, and the team-name match is what actually establishes
 * identity, so the wider window costs nothing in precision.
 */
export async function syncBroadcasts({ log = console.log, from = null, to = null } = {}) {
  const now = new Date();
  // Windowed so the near pass can run this too. A broadcaster is assigned close to
  // kickoff -- the Premier League had a listing for the current week and none for
  // the following month -- so the fixtures worth re-asking about are the ones about
  // to be played, and re-scanning the whole fortnight every few hours would spend
  // the request budget on games nobody has decided about yet.
  const start = from ?? now;
  const horizon = to ?? new Date(now.getTime() + config.sports.horizonDays * 86400_000);
  const events = await q.listEventsMissingBroadcast({ from: start, to: horizon, limit: 2000 });
  if (events.length === 0) return { checked: 0, filled: 0, requests: 0 };

  const dayOf = (d, offset = 0) =>
    new Date(new Date(d).getTime() + offset * 86400_000).toISOString().slice(0, 10);

  /** @type {Map<string, Array<object>>} */
  const cache = new Map();
  let requests = 0;

  /**
   * On a subscriber key a whole DAY comes back in one request, so the sport filter
   * is not just unnecessary -- it is seventeen times the requests for a subset of
   * the same answer. Measured 2026-08-21 with the paid key: one unfiltered day
   * returned 795 listings against 576 for soccer alone, and 44 for Australian
   * Football where the free key returned one.
   *
   * The shared key still needs the filter, because it truncates to a single row and
   * an unfiltered query spends that row on whichever sport happens to sort first.
   */
  const perSport = sportsdb.usingFreeKey();

  async function listings(sport, day) {
    const key = perSport ? `${sport}|${day}` : day;
    if (cache.has(key)) return cache.get(key);
    // Bound the run rather than the work list. Past the cap the remaining fixtures
    // wait for the next pass, which is the right trade for a decorative field.
    if (requests >= BROADCAST_REQUEST_CAP) return [];
    requests++;
    const rows = await sportsdb.fetchTvListings({ date: day, sport: perSport ? sport : null });
    cache.set(key, rows);
    return rows;
  }

  const updates = [];
  for (const e of events) {
    // Only meaningful when the sport is being used to narrow the query. Unfiltered,
    // a sport we have no name for is still covered by the day's listings.
    if (perSport && !sportsdb.sportName(e.sport)) continue;
    const rows = [
      ...(await listings(e.sport, dayOf(e.starts_at, -1))),
      ...(await listings(e.sport, dayOf(e.starts_at))),
    ];
    const hits = sportsdb.matchListings({ home: e.home_name, away: e.away_name }, rows);
    const markets = sportsdb.allMarkets(hits);
    if (markets.length === 0) continue;
    // Every market is stored for the picker; the flat columns keep carrying the
    // primary one, because the feeds and the reminder emails have nowhere to put
    // a tab strip and still need a single sentence.
    const [primary] = markets;
    updates.push({
      id: e.id,
      broadcast: primary.channels.join(', '),
      country: primary.country === 'International' ? null : primary.country,
      markets,
    });
  }

  const written = await q.fillMissingBroadcasts(updates);
  log(
    `[broadcasts] ${events.length} missing, ${written.length} filled, ${requests} requests` +
      (sportsdb.usingFreeKey()
        ? ' (SPORTSDB_API_KEY unset: the shared key returns ONE row per query, so coverage is a trickle)'
        : ' (whole days, one request each)'),
  );
  return { checked: events.length, filled: written.length, requests };
}

/**
 * Refresh the fixtures that are about to be played, and nothing else.
 *
 * The full sweep asks all 359 leagues for a fortnight and costs two requests each,
 * which is far too much to repeat every few hours -- and almost all of it is spent
 * re-reading competitions that are out of season or not playing until next week.
 * Measured 2026-08-21: 48 leagues had a fixture today, 74 within 48 hours. So this
 * asks those, for a two-day window, without the roster.
 *
 * It exists because a fixture is NOT static once written down, which is the
 * assumption that would otherwise justify fetching a day's schedule once. Three
 * things about today's games change during today:
 *
 *   - the broadcaster, which is assigned late and is why events.broadcast is empty
 *     for so much of the catalogue when the sweep first sees a fixture;
 *   - postponements and delays, which move starts_at and state hours ahead of
 *     kickoff, where the live tick's 30-minute window cannot see them;
 *   - each side's record, which changes every time either team plays.
 *
 * The live tick still owns scores. This owns everything about a fixture that is
 * not the score.
 */
export async function syncNear({ log = console.log, hours = config.sports.nearWindowHours } = {}) {
  const now = new Date();
  // Six hours back for the same reason the sweep reaches back: a game that kicked
  // off before the last pass still needs its final state written.
  const from = new Date(now.getTime() - 6 * 3600_000);
  const to = new Date(now.getTime() + hours * 3600_000);

  const leagues = await q.leaguesWithFixturesBetween({ from, to });
  if (leagues.length === 0) {
    log('[near] nothing scheduled in the window');
    return { leagues: 0, events: 0, failed: 0 };
  }

  let events = 0;
  let failed = 0;
  let i = 0;

  async function worker() {
    while (i < leagues.length) {
      const league = leagues[i++];
      try {
        const r = await syncLeague(league, {
          // Days, and never less than one -- fetchSchedule takes a date window and
          // a sub-day one would ask for a range ending before tonight's games.
          horizonDays: Math.max(1, Math.ceil(hours / 24)),
          backfillDays: 0,
          roster: false,
        });
        events += r.events;
      } catch (err) {
        failed++;
        if (failed <= 5) log(`[near] ${league.slug} failed: ${err.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(config.sports.syncConcurrency, leagues.length) }, worker),
  );

  // Scoped to the same window: this is where a late broadcast assignment lands.
  let broadcasts = { checked: 0, filled: 0, requests: 0 };
  try {
    broadcasts = await syncBroadcasts({ log, from: now, to });
  } catch (err) {
    log(`[near] broadcast pass failed: ${err.message}`);
  }

  log(
    `[near] ${leagues.length} league(s) with games inside ${hours}h, ${events} fixtures, ${failed} failed`,
  );
  return { leagues: leagues.length, events, failed, broadcasts };
}

/**
 * Sync every active league, bounded concurrency.
 *
 * Concurrency is deliberately modest. The upstream is free and unmetered but not
 * ours to hammer; 6 in flight clears 354 leagues in a couple of minutes, which is
 * far inside any sane refresh interval.
 */
export async function syncAll({
  log = console.log,
  concurrency = config.sports.syncConcurrency,
} = {}) {
  const leagues = await q.listLeagues({ limit: 1000 });
  let events = 0;
  let failed = 0;
  let i = 0;

  async function worker() {
    while (i < leagues.length) {
      const league = leagues[i++];
      try {
        const r = await syncLeague(league);
        events += r.events;
      } catch (err) {
        // One dead league must not abort the sweep -- ESPN 404s on competitions
        // that exist in the catalogue but have no current season.
        failed++;
        if (failed <= 10) log(`[sync] ${league.slug} failed: ${err.message}`);
        // Stamp it anyway. Otherwise a permanently-404 league keeps the rosterless
        // count above zero and re-triggers a full 354-league sweep on every single
        // boot, forever, for leagues that will never return one.
        await q.markRostersSynced(league.id).catch(() => {});
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  log(`[sync] ${leagues.length} leagues, ${events} events, ${failed} failed`);

  // A decorative field on a secondary provider must never fail the sweep that
  // keeps the calendar correct, so this is caught rather than awaited into it.
  let broadcasts = { checked: 0, filled: 0, requests: 0 };
  try {
    broadcasts = await syncBroadcasts({ log });
  } catch (err) {
    log(`[broadcasts] pass failed: ${err.message}`);
  }

  return { leagues: leagues.length, events, failed, broadcasts };
}

/* ------------------------------------------------------- non-sports providers -- */

/**
 * Run the catalogue providers this brand has switched on.
 *
 * Sequential on purpose. Running them concurrently would finish sooner and buy
 * nothing -- the slow ones are slow because their provider throttles them, not
 * because we are waiting on ourselves -- while making a rate-limit failure hard to
 * attribute in the log.
 */
export async function syncBrandCatalog({ log = console.log, force = false } = {}) {
  const enabled = new Set(brand.providers);
  const list = CATALOG_ADAPTERS.filter((a) => enabled.has(a.name));
  if (list.length === 0) return [];

  const out = [];
  for (const entry of list) {
    try {
      if (!force) {
        const last = await q.lastSyncedAtForCategory(entry.category);
        if (last) {
          const ageMin = (Date.now() - last.getTime()) / 60_000;
          if (ageMin < entry.minIntervalMinutes) {
            log(`[sync] ${entry.name}: fresh (${Math.round(ageMin)}m old)`);
            continue;
          }
        }
      }

      const extra = {};
      if (entry.category === 'music') {
        // Its genre backfill is one upstream request per artist at one request per
        // second, so it has to know which artists have already been asked about --
        // including the ones that came back with nothing, which is most of them.
        extra.genreCache = new Map();
        extra.lookupBudget = 60;
      }

      const result = await entry.module.fetchAll({ from: new Date(), ...extra });
      if (result.skipped) {
        log(`[sync] ${entry.name}: skipped (${result.skipped})`);
        continue;
      }
      out.push(await ingest(result, { log, name: entry.name }));
    } catch (err) {
      // One provider being down is not a reason to skip the others.
      log(`[sync] ${entry.name}: FAILED ${err.message}`);
    }
  }
  return out;
}
