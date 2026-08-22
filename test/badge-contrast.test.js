import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

/**
 * The live/final label on a fixture, and the class name it used to share.
 *
 * The bug: two unrelated components were both called .badge -- the unread count
 * beside the Messages link, and the status label on every fixture. The unread rule
 * came 1500 lines later, so it won `background` and filled the label with
 * --accent. The label kept its own colour, because `.badge.live` outranks a bare
 * `.badge`, so the text stayed --live. Orange on orange: "Top 3rd" rendered and
 * could not be read, on every event page and every event row.
 *
 * Nothing catches this by looking at either rule on its own, and a screenshot of a
 * page with no live fixture looks perfect. So the test is about the class names.
 */
const css = () =>
  readFile(new URL('../apps/web/public/styles.css', import.meta.url).pathname, 'utf8');

/**
 * Every selector block in the file, as [selector, body] pairs.
 *
 * Comments are stripped first. Without that a rule's own explanatory comment gets
 * swallowed into the selector text -- there is no brace between them to end it --
 * and every lookup for an exact selector silently misses.
 */
const blocks = (text) =>
  [
    ...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|\n)\s*([^{}@\n][^{}]*?)\s*\{([^{}]*)\}/g),
  ].map((m) => [m[2].replace(/\s+/g, ' ').trim(), m[3]]);

describe('the fixture status label', () => {
  test('nothing gives .badge a background', async () => {
    // The whole bug in one assertion. .badge is a coloured word with a dot, not a
    // filled pill, and the moment something fills it the text colour is competing
    // with a background nobody chose for it.
    const offenders = blocks(await css())
      .filter(([sel]) => /(^|[\s,])\.badge\b/.test(sel) && !sel.includes('::'))
      .filter(([, body]) => /(^|;|\s)background(-color)?\s*:/.test(body))
      .map(([sel]) => sel);
    expect(offenders).toEqual([]);
  });

  test('.badge is defined once, so a second one cannot inherit into it', async () => {
    const bare = blocks(await css()).filter(([sel]) => sel === '.badge');
    expect(bare.length).toBe(1);
  });

  test('the unread count is its own class and keeps its pill', async () => {
    const text = await css();
    const [, body] = blocks(text).find(([sel]) => sel === '.unread-count') ?? [];
    expect(body).toBeTruthy();
    expect(body).toContain('background: var(--accent)');
  });
});

describe('the markup uses the names the stylesheet does', () => {
  const read = (p) => readFile(new URL(p, import.meta.url).pathname, 'utf8');

  test('the unread count is not a .badge any more', async () => {
    const layout = await read('../apps/web/src/views/Layout.jsx');
    expect(layout).toContain('class="unread-count"');
    expect(layout).not.toContain('class="badge"');
  });

  test('fixture labels still are', async () => {
    // The other half: renaming the wrong one would leave the label unstyled, which
    // is a different invisible bug rather than a fix.
    const components = await read('../apps/web/src/views/components.jsx');
    expect(components).toContain('class="badge live"');
    expect(components).toContain('class="badge done"');
  });
});
