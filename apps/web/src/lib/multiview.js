/**
 * The multiview address: `/multiview?c=12,34,56`.
 *
 * Channel row ids, comma-separated, in tile order. Pure string work in its own
 * file so the route and the test share one reading of it.
 */

/** Four tiles is a 2x2 grid, which is what fits on half a desktop. */
export const MAX_TILES = 4;

/**
 * Which channels a `?c=` names, in order, deduplicated, capped.
 *
 * Garbage is dropped rather than rejected: a link somebody edited by hand should
 * still open the tiles it does name.
 *
 * @param {string|null|undefined} raw
 * @returns {number[]}
 */
export function parseChannelIds(raw) {
  const out = [];
  for (const part of String(raw ?? '').split(/[,\s]+/)) {
    if (!/^\d{1,12}$/.test(part)) continue;
    const id = Number(part);
    if (id < 1 || out.includes(id)) continue;
    out.push(id);
    if (out.length === MAX_TILES) break;
  }
  return out;
}
