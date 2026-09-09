/**
 * Decoding the character references a syndicated feed arrives with.
 *
 * Shared by the news adapters because none of the aggregators they read does
 * this for them, and the failure is invisible until you look at the page: JSX
 * escapes on the way out, so an undecoded title reaches the reader as the entity
 * itself -- `it&rsquo;s crazy`, or a masthead reading
 * `Al Jazeera &#8211; Breaking News`. Measured on live passes 2026-09-09: 7 of
 * 76 brisk titles and 17 of 75 summaries, and rssamplifier mastheads besides.
 *
 * It lives here rather than in slug.js because a slug is already
 * punctuation-free by the time it is built -- this is about text a person reads.
 */

/** The named references that actually turn up in these corpora, plus the big five. */
const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/**
 * Decode the character references in a title or a summary.
 *
 * `&amp;` is resolved LAST, after the numeric pass. Doing it first turns a
 * double-encoded `&amp;#39;` into `&#39;` and then into an apostrophe that was
 * never in the title -- decoding one layer too many is how a feed's literal
 * "&amp;" becomes somebody else's markup.
 *
 * Returns null for nothing, so a title that was only entities cannot become a
 * blank card.
 */
export function decodeEntities(text) {
  if (text == null) return null;
  const s = String(text)
    .replace(/&#(\d{1,7});/g, (m, d) => safeChar(Number.parseInt(d, 10), m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => safeChar(Number.parseInt(h, 16), m))
    .replace(/&([a-z]+);/gi, (m, n) => {
      const key = n.toLowerCase();
      return key === 'amp' ? m : (NAMED[key] ?? m);
    })
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

/** A code point outside the usable range is left as written rather than guessed at. */
function safeChar(code, original) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return original;
  // Lone surrogates are unpaired halves and would corrupt the string.
  if (code >= 0xd800 && code <= 0xdfff) return original;
  try {
    return String.fromCodePoint(code);
  } catch {
    return original;
  }
}
