import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const APP = new URL('../apps/web/src/app.js', import.meta.url).pathname;

describe('html rendering', () => {
  test('render() emits a doctype', async () => {
    const { render } = await import('../apps/web/src/app.js');
    const out = await render({ toString: () => '<html lang="en"></html>' });
    expect(out.startsWith('<!doctype html>')).toBe(true);
  });

  /**
   * The regression this exists for: hono/jsx emits no doctype, so a page served
   * straight from c.html() renders in quirks mode. It went unnoticed across every
   * route until the served bytes were actually read.
   */
  test('no route hands raw JSX to c.html()', async () => {
    const src = await readFile(APP, 'utf8');

    // c.html( followed by a JSX element rather than a string or a render() call.
    const offenders = [...src.matchAll(/c\.html\(\s*\n?\s*<[A-Z]/g)];
    expect(offenders.map((m) => src.slice(m.index, m.index + 60))).toEqual([]);
  });

  test('every JSX element reaching c.html goes through render()', async () => {
    const src = await readFile(APP, 'utf8');
    // Each c.html( call must be followed, within a short window, by render( or a
    // plain variable (the cache path, which already rendered).
    const calls = [...src.matchAll(/c\.html\(([\s\S]{0,40})/g)];
    expect(calls.length).toBeGreaterThan(5);
    for (const m of calls) {
      const head = m[1];
      // The cache path passes an already-rendered string through.
      const ok = /render\(/.test(head) || /^\s*(await produce\(\)|hit\)|body\))/.test(head);
      if (!ok) throw new Error(`c.html() without render(): ${JSON.stringify(head.slice(0, 50))}`);
    }
  });
});
