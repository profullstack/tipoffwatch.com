import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';
process.env.PLAYLIST_SECRET ??= 'test-secret-for-sealing-values';

const { hasTeamRadio, matchesTeam, TEAM_RADIO_LEAGUES, teamTerms } = await import(
  '../packages/radio/src/teams.js'
);

/*
 * Finding a team's own feed: which leagues have one, how a name is split, and
 * what counts as a channel naming the team. The search itself is SiriusXM's;
 * these are the parts that decide what is asked and what is kept.
 */
describe('leagues with team feeds', () => {
  test('the American national leagues, by our slug, and nothing abroad', () => {
    for (const slug of ['nfl', 'nba', 'mlb', 'nhl', 'college-football', 'usa.1']) {
      expect(hasTeamRadio(slug)).toBe(true);
    }
    for (const slug of ['eng.1', 'uefa.champions', 'f1', 'atp', null, undefined, '']) {
      expect(hasTeamRadio(slug)).toBe(false);
    }
    expect(TEAM_RADIO_LEAGUES.size).toBeGreaterThan(5);
  });
});

describe('team names', () => {
  test('uses the provider nickname when there is one', () => {
    const t = teamTerms({ display_name: 'Denver Broncos', name: 'Broncos' });
    expect(t).toMatchObject({ full: 'denver broncos', nickname: 'broncos', place: 'denver' });
  });
  test('falls back to the last word, skipping club suffixes', () => {
    expect(teamTerms('Tampa Bay Buccaneers').nickname).toBe('buccaneers');
    expect(teamTerms('Inter Miami CF').nickname).toBe('miami');
    // "United" is half the clubs in the world; with no nickname left, only the
    // full name can match, which is the right amount of caution.
    expect(teamTerms('Atlanta United FC').nickname).toBe('');
    expect(teamTerms('LA Galaxy').place).toBe('la');
  });
  test('a multi-word nickname from the provider keeps the school as the place', () => {
    const t = teamTerms({ display_name: 'Alabama Crimson Tide', name: 'Crimson Tide' });
    expect(t.nickname).toBe('crimson tide');
    expect(t.place).toBe('alabama');
  });
  test('one word is a name with no nickname', () => {
    expect(teamTerms('Arsenal')).toMatchObject({ full: 'arsenal', nickname: '', place: '' });
  });
});

describe('matching a channel to a team', () => {
  const broncos = teamTerms({ display_name: 'Denver Broncos', name: 'Broncos' });
  const jets = teamTerms({ display_name: 'New York Jets', name: 'Jets' });
  const sox = teamTerms({ display_name: 'Boston Red Sox', name: 'Red Sox' });
  const bama = teamTerms({ display_name: 'Alabama Crimson Tide', name: 'Crimson Tide' });

  test('the full name is the strong match, in the title or the description', () => {
    expect(matchesTeam({ title: 'Denver Broncos', description: '' }, broncos)).toBe(3);
    expect(
      matchesTeam({ title: 'NFL Home Feed', description: 'Denver Broncos vs Chiefs' }, broncos),
    ).toBe(3);
  });
  test('a distinctive nickname alone is enough; a short one is not', () => {
    expect(matchesTeam({ title: 'Broncos Radio' }, broncos)).toBe(2);
    expect(matchesTeam({ title: 'Jets Radio Network' }, jets)).toBe(2);
    // "Sox" would also be the White Sox; the two-word nickname is what is looked for.
    expect(matchesTeam({ title: 'Sox Talk' }, sox)).toBe(0);
    expect(matchesTeam({ title: 'Red Sox Radio' }, sox)).toBe(2);
  });
  test('word boundaries: Jets is not Jetsons', () => {
    expect(matchesTeam({ title: 'The Jetsons Hour' }, jets)).toBe(0);
  });
  test('a college is found by its school, and a pro team is not found by its city', () => {
    expect(matchesTeam({ title: 'Alabama Football' }, bama, { college: true })).toBe(1);
    expect(matchesTeam({ title: 'Alabama Football' }, bama)).toBe(0);
    expect(matchesTeam({ title: 'Denver Sports Talk' }, broncos)).toBe(0);
  });
  test('nothing matches nothing', () => {
    expect(matchesTeam({ title: '' }, broncos)).toBe(0);
    expect(matchesTeam(null, broncos)).toBe(0);
  });
});
