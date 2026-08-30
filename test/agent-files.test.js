import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { llmsTxt, securityTxt, skillMd } = await import('../apps/web/src/lib/well-known.js');
const { config } = await import('../packages/config/src/index.js');
const APP = new URL('../apps/web/src/app.js', import.meta.url).pathname;

describe('llms.txt', () => {
  const out = llmsTxt({ sports: 16, leagues: 363, teams: 12536 });

  test('follows the shape: an H1, a blockquote summary, then linked sections', () => {
    expect(out).toStartWith('# ');
    expect(out).toContain('\n> ');
    expect(out.match(/^## /gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(out.match(/^- \[/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  test('every link is absolute', () => {
    // A model reading this file has no page to resolve a relative path against.
    for (const [, href] of out.matchAll(/^- \[[^\]]+\]\(([^)]+)\)/gm)) {
      expect(href).toStartWith(config.siteUrl);
    }
  });

  test('every link has a description after it', () => {
    for (const line of out.split('\n').filter((l) => l.startsWith('- ['))) {
      expect(line).toMatch(/\):\s+\S/);
    }
  });

  test('the counts come from the catalogue, not from the file', () => {
    // A number typed into a static file is a number that is wrong by next week.
    expect(out).toContain('363');
    expect(llmsTxt({ sports: 4, leagues: 9, teams: 11 })).toContain('9');
  });

  test('and it degrades to prose when the catalogue cannot be read', () => {
    // A boot-time database blip must not publish "undefined leagues".
    const bare = llmsTxt({});
    expect(bare).not.toContain('undefined');
    expect(bare).not.toContain('NaN');
  });

  test('points at the pages it promises', () => {
    for (const path of ['/about', '/premium', '/contact', '/privacy', '/api/v1', '/feeds']) {
      expect(out).toContain(`${config.siteUrl}${path})`);
    }
  });
});

describe('skill.md', () => {
  const out = skillMd();

  test('names the base URL and the read endpoints', () => {
    expect(out).toContain(config.siteUrl);
    expect(out).toContain('GET /api/v1/events');
    expect(out).toContain('GET /api/v1/search?q=');
  });

  /*
   * The API paths are registered literally -- `sports`, `leagues`, `events` -- on
   * every site running this code; only what a reader is SHOWN follows the brand's
   * vocabulary. A skill file that interpolated the vocabulary into the paths
   * would document routes that 404 on the sibling site.
   */
  test('documents the literal routes, not this brand vocabulary', async () => {
    const src = await readFile(APP, 'utf8');
    for (const path of ['/api/v1/sports', '/api/v1/leagues', '/api/v1/events']) {
      expect(out).toContain(path);
      expect(src).toContain(`app.get('${path}'`);
    }
  });

  test('says plainly that writes need a person', () => {
    // An agent must not be able to sign a reader up for notifications.
    expect(out.toLowerCase()).toContain('signed-in session');
  });

  test('warns that a date-only fixture has no start time', () => {
    expect(out).toContain('time_known');
  });
});

describe('security.txt', () => {
  const out = securityTxt();

  test('carries the two fields RFC 9116 requires', () => {
    expect(out).toContain('Contact: ');
    expect(out).toContain('Expires: ');
  });

  test('the contact is a page, so it works before a mailbox does', () => {
    expect(out).toContain(`Contact: ${config.siteUrl}/contact`);
  });

  test('Expires is in the future and renews on redeploy', () => {
    const at = new Date(out.match(/Expires: (\S+)/)[1]);
    expect(at.getTime()).toBeGreaterThan(Date.now());
  });

  test('is served from the well-known path it declares as canonical', async () => {
    const src = await readFile(APP, 'utf8');
    expect(out).toContain(`Canonical: ${config.siteUrl}/.well-known/security.txt`);
    expect(src).toContain("app.get('/.well-known/security.txt'");
  });
});
