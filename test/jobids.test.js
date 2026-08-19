import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const files = ['../packages/queue/src/index.js', '../packages/queue/src/workers.js'].map(
  (f) => new URL(f, import.meta.url).pathname,
);

/**
 * BullMQ reserves ':' in custom job ids for its own repeatable-job keys and throws
 * "Custom Id cannot contain :" unless the id splits into exactly three parts.
 *
 * This is a runtime-only failure with no type or lint signal, and it is silent until
 * the exact code path runs: a two-part id killed the container on boot, and a
 * four-part id in the fan-out would only have thrown once a real user followed a
 * team -- in production, at kickoff.
 */
describe('bullmq job ids', () => {
  test('no job id contains a colon', async () => {
    const offenders = [];
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      for (const m of src.matchAll(/jobId:\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
        if (m[1].includes(':')) offenders.push(`${f.split('/').pop()}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the ids that exist are still distinct per event, offset and page', async () => {
    const src = await readFile(files[1], 'utf8');
    // Guards against "fixing" the colon by dropping the interpolations that make
    // the id unique, which would silently collapse every page onto one job.
    expect(src).toContain('`fo-${e.id}-${offsetMinutes}`');
    expect(src).toContain('`bt-${eventId}-${offsetMinutes}-${after}`');
  });
});
