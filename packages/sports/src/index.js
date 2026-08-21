import { config } from '@tipoff/config';
import * as q from '@tipoff/db/queries';
import * as espn from './espn.js';

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
  return n;
}

/**
 * Pull fixtures for one league and persist them.
 *
 * Teams are upserted first and mapped provider_key -> id, because an event row needs
 * real foreign keys. Doing it per league (rather than globally) keeps the working set
 * small enough that the whole league lands in one transaction-sized batch.
 */
export async function syncLeague(league, { horizonDays = config.sports.horizonDays } = {}) {
  const adapter = ADAPTERS[league.provider];
  if (!adapter) throw new Error(`No adapter for provider ${league.provider}`);

  const from = new Date(Date.now() - 6 * 3600_000);
  const to = new Date(Date.now() + horizonDays * 86_400_000);

  // Roster and fixtures are fetched independently on purpose.
  //
  // Promise.all here meant a failing schedule threw away a perfectly good roster,
  // so an out-of-season league ended up with no fixtures AND no teams -- a blank
  // page for most of the catalogue for most of the year. They are different
  // questions and one failing should not erase the other's answer.
  const [scheduleResult, rosterResult] = await Promise.allSettled([
    adapter.fetchSchedule({ providerKey: league.provider_key, from, to }),
    adapter.fetchTeams ? adapter.fetchTeams(league.provider_key) : Promise.resolve([]),
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
    await q.markRostersSynced(league.id);
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
  await q.markRostersSynced(league.id);
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
  return { leagues: leagues.length, events, failed };
}
