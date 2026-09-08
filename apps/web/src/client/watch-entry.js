/**
 * The channel player, bundled as a global.
 *
 * The house player -- @profullstack/player -- with its control bar, its engine
 * ladder and its recovery ladder. The same package the codec table, the
 * playlist parser and the radio bar already come from.
 *
 * This replaced a hand-rolled hls.js player, and the package had already solved
 * the bug that one shipped with. `canPlayType('application/vnd.apple.mpegurl')`
 * LIES: Chrome answers "maybe" on builds that cannot play a playlist at all,
 * because it is a claim about a MIME type rather than about a decoder. Trying
 * native first on the strength of it sends every Chrome reader down a path that
 * silently plays nothing. The package runs hls.js wherever Media Source exists
 * and keeps native for iOS, which has no MediaSource and is the one browser
 * that genuinely does HLS properly.
 *
 * Loaded on demand, like the other two player bundles: hls.js is a couple of
 * hundred kilobytes and most readers on a page with a Play button never press
 * it.
 */

import { createPlayer } from '@profullstack/player';

const stage = document.getElementById('channel-stage');
if (stage?.dataset.src) {
  const note = document.querySelector('[data-player-note]');
  const say = (text) => {
    if (note) note.textContent = text;
  };

  const player = createPlayer(stage, {
    src: stage.dataset.src,
    kind: 'hls',
    live: true,
    autoplay: true,
    // Autoplay with sound is refused by every browser, so start muted and let
    // the bar unmute. A player that silently never starts reads as broken.
    muted: true,
    poster: stage.dataset.poster || undefined,
    // A live channel has no position worth restoring.
    mediaId: undefined,
    unplayableAdvice: 'This channel is not playing right now.',
  });

  // These are other people's streams and some of them are always down, so the
  // failure case is normal rather than exceptional and is said plainly.
  player.media?.addEventListener('playing', () => say('Live.'), { once: true });
  player.media?.addEventListener('error', () => {
    if (player.media.error && player.media.error.code !== MediaError.MEDIA_ERR_ABORTED) {
      say('This channel is not playing right now. It has usually stopped at the source.');
    }
  });
}
