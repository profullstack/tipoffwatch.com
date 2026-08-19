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

  // Roster and fixtures in parallel. The roster is what the follow picker lists;
  // without it the picker only shows clubs with a game inside the horizon.
  const [{ league: meta, events: fixtures }, roster] = await Promise.all([
    adapter.fetchSchedule({ providerKey: league.provider_key, from, to }),
    adapter.fetchTeams ? adapter.fetchTeams(league.provider_key) : Promise.resolve([]),
  ]);

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
    if (teamRows.size > 0) await q.upsertTeams([...teamRows.values()]);
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
