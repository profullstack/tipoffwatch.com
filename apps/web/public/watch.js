/**
 * Play a proxied HLS channel.
 *
 * Two paths, and the order matters. Safari (and iOS, where every browser is
 * Safari underneath) plays HLS natively and does it better than any library
 * can, because it hands the stream to the platform decoder. So native is tried
 * FIRST and hls.js only fills in for the browsers that cannot.
 *
 * Everything the player fetches is same-origin: the playlist was rewritten so
 * its segments point back here. That is what makes this work at all -- a public
 * channel's own CDN sends no CORS headers, so a browser fetching it directly
 * gets nothing, and the failure looks like a broken player rather than a policy.
 */
(() => {
  const video = document.getElementById('channel-player');
  if (!video) return;
  const src = video.dataset.src;
  const note = document.querySelector('[data-player-note]');
  const say = (text) => {
    if (note) note.textContent = text;
  };

  // A live channel that will not start is the normal failure here, not an
  // exception: these are other people's streams and some of them are down.
  const failed = (why) => say(`This channel is not playing right now (${why}).`);

  video.addEventListener('playing', () => say('Live.'), { once: true });

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
    video.addEventListener('error', () => failed('the stream did not open'), { once: true });
    return;
  }

  const Hls = window.Hls;
  if (!Hls?.isSupported()) {
    failed('this browser cannot play HLS');
    return;
  }

  const hls = new Hls({
    // These are live streams with no seekable past, so there is nothing to gain
    // from a deep buffer and a lot to lose in time-to-first-frame.
    lowLatencyMode: true,
    backBufferLength: 30,
  });
  hls.on(Hls.Events.ERROR, (_evt, data) => {
    if (!data?.fatal) return;
    // A fatal network or media error is often recoverable, and recovering is
    // the difference between "it buffers sometimes" and "it broke".
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    else {
      hls.destroy();
      failed('the stream stopped');
    }
  });
  hls.loadSource(src);
  hls.attachMedia(video);
})();
