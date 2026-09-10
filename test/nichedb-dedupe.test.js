import { describe, expect, test } from 'bun:test';
import { dedupeItems } from '../packages/sports/src/nichedbsports.js';

describe('a page from nichedb, one row per thing', () => {
  test('the same fixture from two sources becomes the fresher one', () => {
    const schedule = {
      id: 3599386,
      source: 'espn-schedule',
      external_id: 'espn:fixture:basketball/fiba/401917254',
      updated_at: '2026-09-10T17:03:04.092Z',
      data: { state: 'pre' },
    };
    const live = {
      id: 3874958,
      source: 'espn-live',
      external_id: 'espn:fixture:basketball/fiba/401917254',
      updated_at: '2026-09-10T17:16:00.361Z',
      data: { state: 'in' },
    };
    expect(dedupeItems([schedule, live])).toEqual([live]);
    expect(dedupeItems([live, schedule])).toEqual([live]);
  });
  test('different things stay, in page order, and rows without a key are dropped', () => {
    const a = { id: 1, external_id: 'a', updated_at: '2026-09-10T10:00:00Z' };
    const b = { id: 2, external_id: 'b', updated_at: '2026-09-10T09:00:00Z' };
    expect(dedupeItems([a, b])).toEqual([a, b]);
    expect(dedupeItems([a, {}, b, null])).toEqual([a, b]);
    expect(dedupeItems(undefined)).toEqual([]);
  });
  test('an item with no external id is keyed by its own id', () => {
    const x = { id: 7, updated_at: '2026-09-10T10:00:00Z' };
    expect(dedupeItems([x, { ...x, updated_at: '2026-09-10T11:00:00Z' }])).toHaveLength(1);
  });
});
