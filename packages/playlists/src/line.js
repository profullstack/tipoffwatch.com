/**
 * How many streams one line may carry at once.
 *
 * Its own file with no imports, like mask.js and for the same reason: this is a
 * three-way minimum and a test of it should not have to load the database.
 *
 * Three voices, and the quietest wins:
 *
 *   - the reader's own setting (`line_connections`), null meaning "whatever my
 *     provider reports";
 *   - the provider's panel (`panel_connections`), null meaning it was not asked or
 *     would not say;
 *   - the site ceiling, which is about money -- every stream through the proxy is
 *     bandwidth billed twice -- and not about any line.
 *
 * The reader may lower the panel's number and may never raise it: two connections
 * on a line that permits one is how a subscription gets suspended, and the whole
 * reason the cap exists is to protect them from that. With no panel and no
 * setting the answer is one, which is what a typical line permits and what the
 * proxy has always enforced.
 *
 * @param {{ line_connections?: unknown, panel_connections?: unknown } | null} row
 * @param {number} ceiling
 * @returns {number} at least 1
 */
export function lineAllowance(row, ceiling = 1) {
  const chosen = positive(row?.line_connections);
  const panel = positive(row?.panel_connections);
  const cap = positive(ceiling) ?? 1;

  // The panel's word is the default when the reader has not chosen; a chosen
  // value is still held under the panel's.
  const wanted = chosen ?? panel ?? 1;
  return Math.max(1, Math.min(wanted, panel ?? Number.POSITIVE_INFINITY, cap));
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}
