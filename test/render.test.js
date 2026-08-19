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

/**
 * Fetching data and then not passing it to the view.
 *
 * The /events/:id handler awaited six values and rendered with two. Follow state,
 * the play-by-play log and the comments were all queried on every request and
 * silently dropped -- the page rendered its empty states instead, which is exactly
 * what an event with no comments looks like. Nothing failed.
 *
 * So: anything a route destructures out of its Promise.all has to be referenced
 * again somewhere in that handler.
 */
test('every value a route awaits is actually used', async () => {
  const source = await Bun.file(new URL('../apps/web/src/app.js', import.meta.url).pathname).text();

  // Each `const [a, b] = await Promise.all([...])` and the handler body after it.
  const pattern = /const \[([^\]]+)\] = await Promise\.all\(\[/g;
  const unused = [];

  for (const match of source.matchAll(pattern)) {
    const names = match[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    // The handler ends at the next top-level `app.` route registration.
    const after = source.slice(match.index + match[0].length);
    const end = after.search(/\napp\.(get|post|put|delete)\(/);
    const body = end === -1 ? after : after.slice(0, end);
    // Skip the destructuring line itself so a name does not match its own declaration.
    const rest = body.slice(body.indexOf(']'));

    for (const name of names) {
      if (!new RegExp(`\\b${name}\\b`).test(rest)) unused.push(name);
    }
  }

  expect(unused).toEqual([]);
});
