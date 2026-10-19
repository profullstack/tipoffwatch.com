import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { buildPolicy } from '../apps/web/src/lib/security-headers.js';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused';
const { Ad } = await import('../apps/web/src/views/components.jsx');

const SLOT = '00000000-0000-4000-8000-000000000000';
const saved = process.env.CRAWLPROOF_AD_SLOT;
afterEach(() => {
  if (saved === undefined) delete process.env.CRAWLPROOF_AD_SLOT;
  else process.env.CRAWLPROOF_AD_SLOT = saved;
});

describe('the display ad', () => {
  test('renders nothing without a configured slot', () => {
    delete process.env.CRAWLPROOF_AD_SLOT;
    expect(Ad({})).toBeNull();
  });

  test('is one script-free frame on the frame path, text_link, no theme', async () => {
    process.env.CRAWLPROOF_AD_SLOT = SLOT;
    const out = (await Ad({}).toString()).toString();
    expect(out).toContain(`https://crawlproof.com/api/ads/frame?slot=${SLOT}&amp;format=text_link`);
    expect(out).not.toContain('theme=');
    expect(out).not.toContain('allow-scripts');
    expect(out.match(/<iframe/g)?.length).toBe(1);
  });

  test('the CSP admits the frame and nothing wider', () => {
    expect(buildPolicy()).toContain('frame-src https://crawlproof.com');
    expect(buildPolicy()).not.toContain("'unsafe-inline'");
  });

  test('ad.js is not loaded (its srcdoc creative cannot render under this CSP)', async () => {
    const layout = await readFile(
      new URL('../apps/web/src/views/Layout.jsx', import.meta.url).pathname,
      'utf8',
    );
    expect(layout).not.toContain('ad.js');
  });

  test('no slot id is hardcoded in the views', async () => {
    for (const f of ['components.jsx', 'pages.jsx', 'Layout.jsx']) {
      const src = await readFile(
        new URL(`../apps/web/src/views/${f}`, import.meta.url).pathname,
        'utf8',
      );
      expect(src).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }
  });
});
