/**
 * Per-country broadcaster listings, parsed.
 *
 * Lives here rather than in the view because two callers now need it and one of
 * them is the structured-data builder. Leaving it in pages.jsx would have meant
 * jsonld.js importing the view that already imports jsonld.js -- a cycle Bun
 * resolves to `undefined` at module-init time rather than to an error, which is
 * the worst way to find out about one.
 */

/**
 * The markets a fixture is carried in, as `{ country, channels: [name] }`.
 *
 * Stored as jsonb and read back as a string on some paths, so both shapes are
 * accepted. Anything malformed is an empty list rather than a throw: a broadcast
 * listing is a nice-to-have on a page whose job is the kickoff time, and one bad
 * value in one column should not take the fixture down with it.
 */
export function marketsOf(event) {
  const raw = event?.broadcast_markets;
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((m) => m?.country && Array.isArray(m.channels) && m.channels.length);
}
