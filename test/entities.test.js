import { describe, expect, test } from 'bun:test';
import { decodeEntities } from '../packages/sports/src/entities.js';

/**
 * Shared by every adapter that reads a syndicated feed, because none of the
 * aggregators upstream decodes these and JSX escapes on the way out -- so an
 * undecoded title reaches the reader as the entity itself. Measured on live
 * passes 2026-09-09: 7 of 76 brisk titles, 17 of 75 summaries, and rssamplifier
 * mastheads reading `Al Jazeera &#8211; Breaking News`.
 */
describe('character references', () => {
  test('named references become the characters they name', () => {
    expect(decodeEntities('it&rsquo;s crazy&hellip; a &ldquo;crashout&rdquo;')).toBe(
      'it’s crazy… a “crashout”',
    );
  });

  test('numeric and hex references both resolve', () => {
    expect(decodeEntities('caf&#233; &#x2014; open')).toBe('café — open');
    expect(decodeEntities('Tom &amp; Jerry &#8212; again')).toBe('Tom & Jerry — again');
  });

  /*
   * &amp; is resolved last. Decoding it first turns a double-encoded
   * `&amp;#39;` into an apostrophe that was never in the title -- one layer too
   * many is how a feed's literal "&" becomes somebody else's markup.
   */
  test('a literal ampersand is not decoded twice into somebody else markup', () => {
    expect(decodeEntities('Fish &amp;#39;n chips')).toBe('Fish &#39;n chips');
    expect(decodeEntities('A &amp;lt;b&amp;gt; tag')).toBe('A &lt;b&gt; tag');
  });

  test('an unknown or malformed reference is left exactly as written', () => {
    expect(decodeEntities('50% &off; &#; &notareal; x')).toBe('50% &off; &#; &notareal; x');
    // A lone surrogate is an unpaired half that would corrupt the string.
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeEntities('&#0; &#1114112;')).toBe('&#0; &#1114112;');
  });

  test('nothing usable is null, so a blank card cannot be published', () => {
    expect(decodeEntities(null)).toBeNull();
    expect(decodeEntities('')).toBeNull();
    expect(decodeEntities('&nbsp;')).toBeNull();
    expect(decodeEntities('   ')).toBeNull();
  });

  test('runs of whitespace collapse, so a headline stays one line', () => {
    expect(decodeEntities('a\n\n  b\tc')).toBe('a b c');
  });
});
