import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const PUBLIC = new URL('../apps/web/public/', import.meta.url).pathname;
const SOURCES = [
  '../apps/web/src/views/Layout.jsx',
  '../apps/web/src/app.js',
  '../apps/web/public/sw.js',
].map((f) => new URL(f, import.meta.url).pathname);

/** Paths the server answers itself rather than reading straight from public/. */
const ROUTE_SERVED = new Map([
  ['/manifest.webmanifest', null], // generated JSON
  ['/sitemap.xml', null], // generated XML
  ['/favicon.ico', 'icons/favicon.ico'], // root alias for the generated icon
]);

/*
 * Routes served out of a package rather than out of public/.
 *
 * Exempting these would defeat the test: the bug it guards is a path that
 * resolves to nothing. So they are checked the same way, through the module
 * resolver -- if the dependency is dropped or its exports map stops naming the
 * file, this fails exactly as a deleted icon does.
 */
const PACKAGE_SERVED = new Map([
  ['/vendor-multiview.js', '@profullstack/multiview'],
  ['/vendor-multiview.css', '@profullstack/multiview/multiview.css'],
]);

async function referencedPaths() {
  const found = new Set();
  for (const file of SOURCES) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(
      /["'`](\/(?:icons\/[\w.-]+|[\w-]+\.(?:png|ico|svg|css|js|webmanifest)))["'`]/g,
    )) {
      found.add(m[1]);
    }
  }
  return found;
}

/**
 * Every static path the app hands a browser must resolve to something.
 *
 * The bug this guards: icon.svg was deleted but stayed referenced in five places --
 * the favicon link, the manifest, a static route, and the service worker's
 * notification icon and badge. Nothing failed to build, no test broke, and the only
 * symptom was a missing image plus two 404s on every push notification.
 */
describe('static asset references', () => {
  test('every referenced path exists on disk or is served by a known route', async () => {
    const referenced = await referencedPaths();
    expect(referenced.size).toBeGreaterThan(10);

    const missing = [...referenced].filter((p) => {
      if (PACKAGE_SERVED.has(p)) {
        try {
          return !existsSync(Bun.fileURLToPath(import.meta.resolve(PACKAGE_SERVED.get(p))));
        } catch {
          return true;
        }
      }
      if (ROUTE_SERVED.has(p)) {
        const backing = ROUTE_SERVED.get(p);
        return backing !== null && !existsSync(PUBLIC + backing);
      }
      return !existsSync(PUBLIC + p.replace(/^\//, ''));
    });
    expect(missing).toEqual([]);
  });

  test('nothing still points at the deleted icon.svg', async () => {
    for (const file of SOURCES) {
      expect(await readFile(file, 'utf8')).not.toContain('icon.svg');
    }
  });

  test('the header loads the vector mark, versioned, never a bitmap of it', async () => {
    const layout = await readFile(SOURCES[0], 'utf8');
    // logo.png is the 1024px render of the mark, there for anyone who wants a
    // bitmap; linking it from the header would download it on every page to draw
    // a 112px mark that the SVG draws crisper at a fifth of the bytes.
    expect(layout).not.toContain('"/logo.png"');
    expect(layout).not.toContain('"/favicon.png"');
    expect(layout).toContain('class="brand-logo"');

    // Through assetUrl, so a redrawn mark is a new URL rather than a week-old cache.
    const header = /<a class="brand" href="\/">\s*<img\s+src=\{assetUrl\('logo\.svg'\)\}/.exec(
      layout,
    );
    expect(header).toBeTruthy();
    const { size } = await Bun.file(`${PUBLIC}logo.svg`).stat();
    expect(size).toBeLessThan(100_000);
  });

  test('the tab icon is the vector too, with the PNG sizes behind it for Safari', async () => {
    const layout = await readFile(SOURCES[0], 'utf8');
    const icons = [...layout.matchAll(/<link rel="icon" type="([\w/+]+)"/g)].map((m) => m[1]);
    expect(icons[0]).toBe('image/svg+xml');
    expect(icons).toContain('image/png');
  });

  test('the mark is served as an image, hashed with the other assets', async () => {
    const app = await readFile(SOURCES[1], 'utf8');
    // In STATIC_FILES rather than a route of its own: that list is what
    // loadAssetVersions hashes, which is what makes assetUrl('logo.svg') versioned.
    expect(app).toContain("['/logo.svg', 'logo.svg', 'image/svg+xml']");
  });

  test('the wordmark is gone but the name survives for screen readers', async () => {
    const layout = await readFile(SOURCES[0], 'utf8');
    // The invariant is that the logo carries the site's name as alt text and is
    // not also repeated as a visible wordmark. Asserted against the brand rather
    // than the literal "TipoffWatch", which was one brand's name and made this
    // fail the moment the alt text started naming the site being served.
    expect(layout).toContain('alt={brand.name}');
    expect(layout).not.toContain('<span>{brand.name}</span>');
  });
});

/** Width and height straight from the IHDR chunk, so checking a size needs no decoder. */
async function pngDimensions(path) {
  const b = Buffer.from(await readFile(path));
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/*
 * The icon set is rendered from logo.svg by `bun run icons` (tools/icons) and
 * committed. The sizes below are the ones the Layout, the manifest and the
 * service worker link, spelled out again on purpose: the bug this guards is a
 * generator run that wrote a different set from the one the markup names, or
 * an icon replaced by hand at the wrong size, neither of which fails a build.
 */
describe('the generated icon set', () => {
  const SIZED = [
    ['icons/favicon-16.png', 16],
    ['icons/favicon-32.png', 32],
    ...[76, 120, 144, 152, 180].map((s) => [`icons/apple-touch-icon-${s}x${s}.png`, s]),
    ...[48, 128, 192, 256, 384, 512].map((s) => [`icons/icon-${s}x${s}.png`, s]),
    ...[192, 512].map((s) => [`icons/icon-${s}x${s}-maskable.png`, s]),
    ['logo.png', 1024],
  ];

  test('every icon the markup links exists at the size its name claims', async () => {
    for (const [file, size] of SIZED) {
      expect([file, ...(await pngDimensions(PUBLIC + file))]).toEqual([file, size, size]);
    }
  });

  test('the mark is a self-contained vector with nothing that runs', async () => {
    const svg = await readFile(`${PUBLIC}logo.svg`, 'utf8');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    // Served same-origin under the page's CSP, but an SVG is a document too:
    // no script, no event handlers, no foreignObject, no reference off-site.
    expect(svg).not.toMatch(/<script|<foreignObject|javascript:|\son[a-z]+=/i);
    expect(svg).not.toMatch(/href="(?!#)/);
  });

  test('favicon.ico holds the small sizes as PNG entries', async () => {
    const b = Buffer.from(await readFile(`${PUBLIC}icons/favicon.ico`));
    expect(b.readUInt16LE(2)).toBe(1); // type: icon, not cursor
    const sizes = [];
    for (let i = 0; i < b.readUInt16LE(4); i++) {
      const entry = 6 + 16 * i;
      const offset = b.readUInt32LE(entry + 12);
      expect(b.subarray(offset + 1, offset + 4).toString()).toBe('PNG');
      sizes.push(b.readUInt8(entry));
    }
    expect(sizes).toEqual([16, 32, 48]);
  });
});
