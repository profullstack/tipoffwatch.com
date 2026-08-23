import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { entryKind, groupsOf, parseM3u } from '../packages/sports/src/m3u.js';

/**
 * The playlist parser, after the fix ported from the sibling brand.
 *
 * Two things changed and both were real bugs rather than tidying: the title was
 * taken from the FIRST comma on the line, and `group-title` was parsed and thrown
 * away. Together they meant a provider list whose groups contain commas -- which
 * is most of them -- stored a fragment of its own metadata as the channel name.
 */

const line = (attrs, title, url) => `#EXTINF:-1 ${attrs},${title}\n${url}`;

describe('reading an #EXTINF line', () => {
  /*
   * The regression this exists for. `group-title="Sports, US"` has a comma inside
   * quotes, and splitting on the first comma made the title ` US",ESPN HD` --
   * which then matched nothing, so the reader's own ESPN was invisible on every
   * fixture page.
   */
  test('a comma inside an attribute does not eat the title', () => {
    const [ch] = parseM3u(line('group-title="Sports, US"', 'ESPN HD', 'http://x/live/1.ts'));
    expect(ch.title).toBe('ESPN HD');
    expect(ch.group).toBe('Sports, US');
  });

  test('a line with no attributes still parses', () => {
    const [ch] = parseM3u(line('', 'BBC One', 'http://x/live/2.ts'));
    expect(ch.title).toBe('BBC One');
    expect(ch.group).toBeNull();
  });

  /* Providers state the group either way, and some lists use both. */
  test('#EXTGRP applies until it is changed', () => {
    const text = [
      '#EXTM3U',
      '#EXTGRP:PPV',
      line('', 'Fight Night 1', 'http://x/live/3.ts'),
      line('', 'Fight Night 2', 'http://x/live/4.ts'),
      '#EXTGRP:Kids',
      line('', 'Cartoons', 'http://x/live/5.ts'),
    ].join('\n');
    const rows = parseM3u(text);
    expect(rows.map((r) => r.group)).toEqual(['PPV', 'PPV', 'Kids']);
  });

  test('group-title wins over a standing #EXTGRP', () => {
    const text = [
      '#EXTGRP:Kids',
      line('group-title="Movies"', 'Dune', 'http://x/movie/6.mkv'),
    ].join('\n');
    expect(parseM3u(text)[0].group).toBe('Movies');
  });

  test('a titleless slot falls back to tvg-name rather than being dropped', () => {
    const [ch] = parseM3u(line('tvg-name="NFL Sunday Ticket 3"', '', 'http://x/live/7.ts'));
    expect(ch.title).toBe('NFL Sunday Ticket 3');
  });

  test('an entry with no usable URL is skipped', () => {
    expect(parseM3u(line('', 'Nothing', 'rtmp://x/8'))).toEqual([]);
  });
});

describe('what kind of entry it is', () => {
  /*
   * Not cosmetic: a file is available whenever you want it and a channel is a
   * claim about right now. The URL is authoritative because a provider panel
   * encodes it there and is consistent; the group is the fallback for lists that
   * do not.
   */
  test('the URL path decides where it says', () => {
    expect(entryKind({ url: 'http://x/live/1.ts' })).toBe('live');
    expect(entryKind({ url: 'http://x/movie/1.mkv' })).toBe('vod');
    expect(entryKind({ url: 'http://x/series/1.mp4' })).toBe('series');
  });

  test('a file extension counts even without a path segment', () => {
    expect(entryKind({ url: 'http://x/9182.mp4' })).toBe('vod');
  });

  test('the group answers when the URL does not', () => {
    expect(entryKind({ url: 'http://x/9182', group: 'VOD | Action' })).toBe('vod');
    expect(entryKind({ url: 'http://x/9182', group: 'TV Shows' })).toBe('series');
  });

  /* Nothing said either way. A channel is the safe assumption: it is what every
     row imported before this existed actually was. */
  test('and it is a channel when nothing says otherwise', () => {
    expect(entryKind({ url: 'http://x/9182' })).toBe('live');
  });
});

describe('the groups in a list', () => {
  const rows = parseM3u(
    [
      line('group-title="Sports"', 'A', 'http://x/live/1.ts'),
      line('group-title="Sports"', 'B', 'http://x/live/2.ts'),
      line('group-title="Movies"', 'C', 'http://x/movie/3.mkv'),
      line('', 'D', 'http://x/live/4.ts'),
    ].join('\n'),
  );

  test('are counted, largest first', () => {
    expect(groupsOf(rows)).toEqual([
      { name: 'Sports', count: 2 },
      { name: 'Movies', count: 1 },
    ]);
  });

  test('and an ungrouped entry is not invented into a group', () => {
    expect(groupsOf(rows).map((g) => g.name)).not.toContain('');
  });
});

describe('what reaches the database', () => {
  const importer = readFileSync(
    new URL('../packages/playlists/src/index.js', import.meta.url).pathname,
    'utf8',
  );

  test('the group and the kind are stored, not recomputed per read', () => {
    expect(importer).toContain('groupTitle: c.group');
    expect(importer).toContain('kind: c.kind');
  });

  /*
   * The URL is the credential. It is sealed per row, which is also why `kind` has
   * to be a column: working it out on a page would mean decrypting several
   * thousand rows to look at their paths.
   */
  test('every stream URL is still sealed individually', () => {
    expect(importer).toContain('streamUrl: seal(c.url)');
  });
});
