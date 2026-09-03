/**
 * The radio player, bundled as a global.
 *
 * The house player -- @profullstack/player -- with its compact audio bar, its
 * hls.js engine and its recovery ladder. It is the same package the codec table
 * and the playlist parser already come from; this is the first place on the
 * site that draws its control bar, because the live TV player predates it and
 * keeps its own.
 *
 * Loaded on demand like the transport stream demuxer: hls.js is a couple of
 * hundred kilobytes and most readers on a page with a Play button never press
 * it. app.js injects the tag on the first press.
 */

import { createPlayer } from '@profullstack/player';

/** Can this browser play HLS through Media Source? iPhone Safari cannot, and has no fallback we can offer. */
function supported() {
  try {
    return (
      typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')
    );
  } catch {
    return false;
  }
}

/**
 * Tell the OS what is playing, so the lock screen and the headset buttons
 * work. The player owns the element; this only decorates it.
 */
function mediaSession(media, meta, onStop) {
  if (!('mediaSession' in navigator)) return () => undefined;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.title ?? 'SiriusXM',
      artist: 'SiriusXM',
      album: meta.album ?? 'Live radio',
      artwork: meta.artwork ? [{ src: meta.artwork, sizes: '300x300' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => media.play().catch(() => undefined));
    navigator.mediaSession.setActionHandler('pause', () => media.pause());
    navigator.mediaSession.setActionHandler('stop', onStop);
  } catch {
    // An older browser with the property and none of the constructors.
  }
  return () => {
    try {
      navigator.mediaSession.metadata = null;
      for (const action of ['play', 'pause', 'stop'])
        navigator.mediaSession.setActionHandler(action, null);
    } catch {
      // nothing to clear
    }
  };
}

/**
 * Play one station into a stage element.
 *
 * @param {HTMLElement} stage an empty block the bar is built into
 * @param {string} src the same-origin playlist URL
 * @param {{title?: string, album?: string, artwork?: string,
 *   onError: (message: string) => void, onNotice: (message: string|null) => void,
 *   onStop: () => void}} meta
 * @returns {() => void} teardown
 */
function play(stage, src, meta) {
  const media = document.createElement('audio');
  media.autoplay = true;
  stage.append(media);
  const player = createPlayer(stage, {
    src,
    kind: 'hls',
    audio: true,
    live: true,
    media,
    autoplay: true,
    withCredentials: true,
    unplayableAdvice: '',
    // A live station has no position worth remembering.
    mediaId: undefined,
  });
  const clearSession = mediaSession(media, meta, meta.onStop);
  media.addEventListener('error', () => {
    // hls.js reports its own failures through the bar; this is the element
    // itself giving up, which the bar does not always see.
    if (media.error && media.error.code !== MediaError.MEDIA_ERR_ABORTED) {
      meta.onError('That station could not be played. Try again in a moment.');
    }
  });
  return () => {
    clearSession();
    player.destroy();
    media.remove();
  };
}

window.__tipoffRadio = { supported, play };
