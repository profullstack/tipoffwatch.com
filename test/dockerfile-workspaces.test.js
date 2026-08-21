import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url).pathname;

/**
 * Every workspace must be copied into the deps stage.
 *
 * Bun's isolated linker gives each workspace its own node_modules rather than
 * hoisting to the root, so the Dockerfile copies each package.json individually
 * before installing. That list is hand-maintained, which means adding a package
 * and forgetting the COPY line is a one-character-invisible mistake that passes
 * every local check and fails only in the image build:
 *
 *   error: Workspace dependency "@tipoff/playlists" not found
 *
 * It has now happened once and cost four consecutive failed deploys, during which
 * the site stayed up on the previous container and nothing looked wrong locally.
 * This test is the check that was missing.
 */
describe('the Dockerfile deps stage', () => {
  test('copies a package.json for every workspace in the repo', async () => {
    const dockerfile = await readFile(`${root}Dockerfile`, 'utf8');

    const dirs = [];
    for (const group of ['packages', 'apps']) {
      for (const entry of await readdir(`${root}${group}`, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(`${group}/${entry.name}`);
      }
    }
    expect(dirs.length).toBeGreaterThan(0);

    const missing = dirs.filter((d) => !dockerfile.includes(`COPY ${d}/package.json`));
    expect(missing).toEqual([]);
  });

  test('does not copy a workspace that no longer exists', async () => {
    const dockerfile = await readFile(`${root}Dockerfile`, 'utf8');
    const copied = [
      ...dockerfile.matchAll(/^COPY ((?:packages|apps)\/[\w.-]+)\/package\.json/gm),
    ].map((m) => m[1]);
    for (const d of copied) {
      const f = Bun.file(`${root}${d}/package.json`);
      // A stale COPY fails the build just as loudly as a missing one.
      expect(await f.exists()).toBe(true);
    }
  });

  test('every workspace dependency names a workspace that exists', async () => {
    const dirs = [];
    for (const group of ['packages', 'apps']) {
      for (const entry of await readdir(`${root}${group}`, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(`${group}/${entry.name}`);
      }
    }
    const names = new Set();
    for (const d of dirs) {
      names.add(JSON.parse(await readFile(`${root}${d}/package.json`, 'utf8')).name);
    }

    for (const d of dirs) {
      const pkg = JSON.parse(await readFile(`${root}${d}/package.json`, 'utf8'));
      for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
        if (typeof range === 'string' && range.startsWith('workspace:')) {
          expect({ from: d, dep, exists: names.has(dep) }).toEqual({ from: d, dep, exists: true });
        }
      }
    }
  });
});
