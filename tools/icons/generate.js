/**
 * The icon set, rendered from the mark.
 *
 * apps/web/public/logo.svg is the logo. Everything under apps/web/public/icons,
 * and logo.png beside it, are renders of that one file at the sizes the Layout,
 * the manifest and the service worker link. After changing the SVG, run
 * `bun run icons` from the repo root and commit what it writes; the sizes are
 * spelled out once here and once in app.js, and the assets test checks that
 * every file the markup can link exists at the size its name claims.
 *
 * sharp (libvips with librsvg) does the rasterising. It lives in this
 * directory's own package.json, outside the workspaces, so the native library
 * is installed by `bun run icons` and never by the Dockerfile.
 *
 * Three grounds, because three surfaces disagree about transparency:
 *
 *  - The `any` icons and the favicons are transparent, like the mark itself.
 *  - The apple-touch icons are flattened on the stylesheet's ground. iOS fills
 *    a transparent home-screen icon with black, which is not what the page
 *    paints, so the icon carries the page's own colour.
 *  - The maskable icons carry their own inset on the same ground. A launcher
 *    crops a maskable icon to a circle of 80% diameter, and the badge is wider
 *    than it is tall, so the full-bleed art would lose both ends of the
 *    wordmark. The inset is derived from the art rather than assumed: the
 *    furthest ink is measured from the mark's own centre and the mark is
 *    scaled until that sits inside the safe circle. The result is checked for
 *    ink outside the circle before it is written.
 */

import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const ROOT = new URL('../../', import.meta.url);
const PUBLIC = new URL('apps/web/public/', ROOT);
const ICONS = new URL('icons/', PUBLIC);

/** The stylesheet's ground: theme-color, background_color and the tile colour. */
const GROUND = { r: 18, g: 22, b: 31, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/** The SVG's own viewBox, and the size the master render is drawn at. */
const SOURCE = 1024;
const MASTER = 2048;

/** Safe-zone radius of a maskable icon as a fraction of its side, and the margin kept inside it. */
const SAFE = 0.4;
const MARGIN = 0.95;

/** Alpha below this is antialiasing, not ink. */
const INK = 8;

const ANY = [16, 32, 48, 128, 192, 256, 384, 512];
const APPLE = [57, 60, 72, 76, 114, 120, 144, 152, 180];
const MASKABLE = [192, 512];
const FAVICON_ICO = [16, 32, 48];

const svg = await readFile(new URL('logo.svg', PUBLIC));

/*
 * One large render, then every size is a downscale of it. librsvg rasterises
 * at 72dpi, so the density is what makes it draw the 1024-unit viewBox at
 * MASTER pixels; lanczos from there gives the small sizes better antialiasing
 * than drawing the vector at 16px would.
 */
const master = await sharp(svg, { density: (72 * MASTER) / SOURCE })
  .resize(MASTER, MASTER, { fit: 'contain', background: CLEAR })
  .png()
  .toBuffer();

const png = (pipeline) => pipeline.png({ compressionLevel: 9, effort: 10 }).toBuffer();

const transparent = (size) =>
  png(sharp(master).resize(size, size, { kernel: 'lanczos3', fit: 'contain', background: CLEAR }));

const flattened = (size) =>
  png(
    sharp(master)
      .resize(size, size, { kernel: 'lanczos3', fit: 'contain', background: GROUND })
      .flatten({ background: GROUND }),
  );

/** Where the ink is: its bounding box, its centre, and how far the furthest ink sits from that centre. */
async function measure(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > INK) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) throw new Error('the mark rendered blank');
  const cx = (left + right + 1) / 2;
  const cy = (top + bottom + 1) / 2;
  let radius = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (data[(y * info.width + x) * 4 + 3] > INK) {
        const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (r > radius) radius = r;
      }
    }
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1, cx, cy, radius };
}

/** Pixels that are not the ground and lie outside the safe circle. */
async function inkOutsideSafeCircle(buffer, size) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let outside = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const away =
        Math.abs(data[i] - GROUND.r) +
        Math.abs(data[i + 1] - GROUND.g) +
        Math.abs(data[i + 2] - GROUND.b);
      if (away > 24 && Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > SAFE * size) outside++;
    }
  }
  return outside;
}

async function maskable(size, art) {
  const scale = (SAFE * MARGIN * size) / art.radius;
  const width = Math.max(1, Math.round(art.width * scale));
  const height = Math.max(1, Math.round(art.height * scale));
  const mark = await sharp(master)
    .extract({ left: art.left, top: art.top, width: art.width, height: art.height })
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
    .png()
    .toBuffer();
  // The ink's centre lands on the icon's centre, which is where the launcher's circle is.
  const left = Math.round(size / 2 - (art.cx - art.left) * scale);
  const top = Math.round(size / 2 - (art.cy - art.top) * scale);
  const out = await png(
    sharp({ create: { width: size, height: size, channels: 4, background: GROUND } }).composite([
      { input: mark, left, top },
    ]),
  );
  const outside = await inkOutsideSafeCircle(out, size);
  if (outside > 0) {
    throw new Error(`${size}px maskable icon has ${outside} ink pixels outside the safe circle`);
  }
  return out;
}

/**
 * An .ico that holds PNG entries, which every browser since Vista reads. Six
 * bytes of header, sixteen per entry, then the images back to back.
 */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = [];
  const images = [];
  let offset = 6 + 16 * entries.length;
  for (const { size, image } of entries) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.length;
    directory.push(entry);
    images.push(image);
  }
  return Buffer.concat([header, ...directory, ...images]);
}

const written = [];
async function write(url, bytes) {
  await writeFile(url, bytes);
  written.push([url.pathname.slice(PUBLIC.pathname.length), bytes.length]);
}

const art = await measure(master);
console.log(
  `mark: ink ${art.width}x${art.height} of ${MASTER}, centre (${art.cx}, ${art.cy}), radius ${art.radius.toFixed(1)}`,
);

for (const size of ANY) {
  await write(new URL(`icon-${size}x${size}.png`, ICONS), await transparent(size));
}
await write(new URL('favicon-16.png', ICONS), await transparent(16));
await write(new URL('favicon-32.png', ICONS), await transparent(32));
await write(new URL('favicon.png', ICONS), await transparent(32));
for (const size of APPLE) {
  await write(new URL(`apple-touch-icon-${size}x${size}.png`, ICONS), await flattened(size));
}
for (const size of MASKABLE) {
  await write(new URL(`icon-${size}x${size}-maskable.png`, ICONS), await maskable(size, art));
}
await write(
  new URL('favicon.ico', ICONS),
  ico(
    await Promise.all(FAVICON_ICO.map(async (size) => ({ size, image: await transparent(size) }))),
  ),
);
await write(new URL('logo.png', PUBLIC), await transparent(SOURCE));

for (const [file, bytes] of written) console.log(`${String(bytes).padStart(8)}  ${file}`);
console.log(`${written.length} files written`);
