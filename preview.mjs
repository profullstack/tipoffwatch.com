/* Renders signed-in pages to static HTML so they can be looked at without a session.
   Scratch tooling: writes into .preview/, which is not committed. */
process.env.DATABASE_URL = 'postgres://localhost:5432/unused';
process.env.SITE_URL = 'https://tipoffwatch.com';

import { cp, mkdir, writeFile } from 'node:fs/promises';

const { Following, PushCheck } = await import('./apps/web/src/views/pages.jsx');

const OUT = new URL('./.preview/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
await cp(new URL('./apps/web/public/', import.meta.url).pathname, OUT, { recursive: true });

const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();

const events = [
  {
    id: 1,
    name: 'Detroit Tigers at Pittsburgh Pirates',
    starts_at: at(3),
    league_name: 'Major League Baseball',
    venue: 'PNC Park',
    status: 'scheduled',
    home_score: null,
    away_score: null,
  },
  {
    id: 2,
    name: 'Málaga at Atlético Madrid',
    starts_at: at(27),
    league_name: 'LaLiga',
    venue: 'Metropolitano',
    status: 'scheduled',
    home_score: null,
    away_score: null,
  },
];

const pages = {
  'following.html': Following({
    user: { id: 1, email: 'you@example.com' },
    events,
    follows: [
      { subject_type: 'team', subject_id: 10, label: 'Pittsburgh Pirates' },
      { subject_type: 'team', subject_id: 11, label: 'Atlético Madrid' },
      { subject_type: 'league', subject_id: 3, label: 'Premier League' },
    ],
    vapidKey:
      'BExampleVapidPublicKeyForLayoutOnly_notARealKey_0000000000000000000000000000000000000',
    calendarUrl: 'https://tipoffwatch.com/calendar/me/00000000-0000-4000-8000-000000000000.ics',
  }),
  'push-check.html': PushCheck({ user: { id: 1 }, vapidKey: 'BDU8swQU' }),
};

for (const [file, node] of Object.entries(pages)) {
  const html = `<!doctype html>${(await node.toString()).toString()}`;
  await writeFile(OUT + file, html);
  console.log('wrote', file, html.length, 'bytes');
}
