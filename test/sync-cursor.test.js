import { describe, expect, test } from 'bun:test';
import { cursorValue } from '../packages/db/src/queries.js';

describe('the sync cursor as read back', () => {
  test('an object is itself, a string is parsed', () => {
    const doc = { since: '2026-09-10T15:00:00.000Z', spend: { hour: 1, calls: 41 } };
    expect(cursorValue(doc)).toEqual(doc);
    expect(cursorValue(JSON.stringify(doc))).toEqual(doc);
  });
  test('nothing, junk and a spread string all read as never synced', () => {
    expect(cursorValue(null)).toBeNull();
    expect(cursorValue(undefined)).toBeNull();
    expect(cursorValue('not json')).toBeNull();
    expect(cursorValue([1])).toBeNull();
    // What a reader that spread the text saved back: one key per character.
    const spread = Object.fromEntries(
      [...JSON.stringify({ since: 'x' })].map((c, i) => [String(i), c]),
    );
    expect(cursorValue(spread)).toBeNull();
    expect(cursorValue(JSON.stringify(spread))).toBeNull();
  });
  test('a real cursor that happens to carry a "0" key is kept', () => {
    expect(cursorValue({ 0: 'x', since: 's' })).toEqual({ 0: 'x', since: 's' });
  });
});
