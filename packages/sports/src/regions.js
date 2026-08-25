/**
 * Where a competition is played, for the ones the provider will not say.
 *
 * ESPN carries `country` on the core league endpoint for DOMESTIC SOCCER and
 * nowhere else. Checked against the live API: `soccer/eng.1` answers England,
 * while `soccer/concacaf.champions_cup`, `basketball/nbl`, `baseball/mlb` and
 * `hockey/nhl` all answer nothing at all. So 218 of 354 leagues can be resolved
 * automatically and the rest cannot.
 *
 * This table is the exception list, and it is deliberately short. The bar for an
 * entry is not "we know where it is" -- it is "without this, the chip names a
 * DIFFERENT competition to a reader". A region nobody needed is clutter on every
 * row it appears in.
 *
 * The one that prompted it: Australia's NBL is officially the National
 * Basketball League. Beside "National Basketball Association" that is a
 * one-word difference rendered as a one-letter chip, and it was reported as the
 * NBA being mislabelled.
 *
 * Keyed by provider_key, which is stable across environments and resyncs, unlike
 * ids and unlike the display names ESPN revises.
 */
export const CURATED_REGIONS = new Map([
  // Reads as the NBA. This is the entry the whole file exists for.
  ['basketball/nbl', 'Australia'],
  // Two more national basketball leagues whose abbreviations are initials of a
  // local-language name, and so identify nothing to an English reader.
  ['basketball/acb', 'Spain'],
  ['basketball/lba', 'Italy'],
  ['basketball/nbb', 'Brazil'],
]);

/**
 * The region for a league, or null.
 *
 * Curation wins over the provider on purpose. ESPN's country for a domestic
 * league is reliable, but where we have chosen to override it we have done so
 * because the automatic answer was not the one a reader needs.
 *
 * @param {string} providerKey e.g. "basketball/nbl"
 * @param {string|null} fromProvider whatever the provider's country field said
 */
export function regionFor(providerKey, fromProvider = null) {
  return CURATED_REGIONS.get(providerKey) ?? fromProvider ?? null;
}
