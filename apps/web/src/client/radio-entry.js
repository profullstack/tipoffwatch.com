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

import { attachAds, createPlayer } from '@profullstack/player';

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
/**
 * How often a break comes round.
 *
 * Five minutes is the house default. Radio convention is far more frequent than
 * this, but the inventory is one five-second spot and the listener asked for a
 * station, not an ad slot.
 */
const AD_EVERY_SECONDS = 300;

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
  // Adverts between songs on a live station.
  //
  // attachAds is the house player's own break machinery, so nothing about
  // scheduling or playback is reimplemented here. What it needs is a source of
  // creatives, and that is the server route: it proxies the ad network, which
  // runs the auction and meters the impression.
  //
  // A break that cannot be filled does not happen. Every failure path on the
  // server answers with a null url and `next` returns null, which attachAds
  // treats as "no advert" — the station keeps playing, which is the only
  // acceptable outcome on something live.
  const ads = attachAds(stage, media, {
    everySeconds: AD_EVERY_SECONDS,
    next: async () => {
      try {
        const answer = await fetch('/api/ads/next', { headers: { accept: 'application/json' } });
        if (!answer.ok) return null;
        const body = await answer.json();
        return body && typeof body.url === 'string' ? { url: body.url, kind: body.kind } : null;
      } catch {
        return null;
      }
    },
    onError: (error) => console.warn('advert failed', error),
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
    // Before the element goes: the break controller holds a timer and listeners
    // on this media element, and a station switched twice would otherwise leave
    // two of them running against elements nobody can see.
    ads.destroy();
    player.destroy();
    media.remove();
  };
}

window.__tipoffRadio = { supported, play };
