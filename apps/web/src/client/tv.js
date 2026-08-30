/**
 * Is this a television?
 *
 * Asked for one reason: a Fire TV stick and a laptop want opposite things from
 * the same live stream, and the player has been tuned for the laptop.
 *
 * A stick behind household wifi, decoding a transport stream on a CPU an order of
 * magnitude slower, needs a read-ahead buffer to survive a jitter spike, and needs
 * whatever closes the gap to the live edge to not do it by seeking -- a seek during
 * a live stream is a rebuffer the viewer sees. Without both it stops and starts
 * until it is abandoned, which is what "it does not play on Silk" looks like from
 * the sofa.
 *
 * A desktop wants a smaller version of the same thing, not the opposite of it. It
 * was given the opposite -- no buffer at all, and drift closed by seeking -- and
 * that was its own kind of stutter: see the desktop branch below, where the whole
 * sawtooth is written out. Both screens now read ahead and neither seeks; they
 * differ in how much they hold and how close they sit to the edge, which is the
 * only thing the device should have been deciding.
 *
 * So the buffering profile is picked per screen. There is no feature to detect
 * here -- the difference is the device, not the API surface -- so this is a user
 * agent test, which is exactly the kind of thing that ages badly and is therefore
 * kept to one list in one file with a test beside it.
 *
 * The patterns are the same set media-streamer uses, and deliberately so: these
 * two players face the same devices and a device that is a television in one and
 * a desktop in the other is a bug waiting in whichever was not looked at.
 */

/**
 * Ordered most specific first, so a Fire TV is a Fire TV rather than a generic
 * Android with the Silk browser on it.
 */
const TV_PATTERNS = [
  // Amazon Fire TV -- the model string, which is the only reliable marker: some
  // Fire TV builds report a plain Chrome user agent with no "Silk" in it.
  [/\bAFT[A-Z0-9]+\b/i, 'firetv'],
  // Kindle Fire tablets.
  [/\bKF[A-Z]+\b/, 'silk'],
  // The Silk browser anywhere else.
  [/\bSilk\b/i, 'silk'],
  [/\bAndroid TV\b/i, 'androidtv'],
  [/\bGoogleTV\b/i, 'googletv'],
  [/\bTizen\b/i, 'tizen'],
  [/\bWeb0S\b/i, 'webos'],
  [/\bRoku\b/i, 'roku'],
  [/AppleTV/i, 'appletv'],
  [/\bCrKey\b/i, 'chromecast'],
  [/\bSMART-TV\b/i, 'smarttv'],
  [/\bSmartTV\b/i, 'smarttv'],
];

/**
 * Which television, or null for anything else.
 *
 * @param {string} userAgent
 * @returns {string|null}
 */
export function tvBrowserType(userAgent) {
  if (!userAgent) return null;
  for (const [re, type] of TV_PATTERNS) if (re.test(userAgent)) return type;
  return null;
}

/**
 * @param {string} userAgent
 * @returns {boolean}
 */
export function isTvBrowser(userAgent) {
  return tvBrowserType(userAgent) !== null;
}

/**
 * mpegts.js settings for one screen or the other.
 *
 * The comments live with the values rather than in the caller, because the reason
 * a value differs between the two is the only interesting thing about it.
 *
 * @param {boolean} isTv
 */
export function playerConfig(isTv) {
  const shared = {
    // lazyLoad pauses the download once enough is buffered, which for a live
    // stream means dropping the connection mid-match and reconnecting.
    lazyLoad: false,
    /*
     * Drop what has already been watched.
     *
     * A football match is three hours. Without this the source buffer keeps
     * every second of it in memory and the tab is killed somewhere in the
     * second half -- on a Fire TV, considerably sooner than that.
     */
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 30,
    autoCleanupMinBackwardDuration: 10,
  };

  if (isTv) {
    return {
      ...shared,
      /*
       * Read ahead, and do not chase.
       *
       * The stash is a read-ahead buffer. On a desktop it is pure added latency;
       * on a stick going through the proxy it is the only thing standing between
       * a wifi hiccup and a stall, so it is on and generously sized. 384KB is
       * mpegts.js's own default and roughly a second of a broadcast bitrate.
       *
       * Latency chasing is off, and is now off on both screens. Its answer to
       * drift is to seek the media element forward; on a link that drifts because
       * it is struggling, that is a seek every few seconds, and a seek during a
       * live stream is a rebuffer. Being ten seconds behind is not a complaint
       * anybody makes. Stopping every ten seconds is.
       *
       * Nothing replaces it here. The desktop closes its drift with liveSync, but
       * a stick is behind because it is struggling, and asking a CPU that is
       * barely keeping up to decode at 1.1x is how you turn a slow stream into a
       * stopped one. A television is allowed to run late.
       *
       * The two `liveBufferLatency*` numbers below are inert while chasing is off.
       * They are kept because they are the bound anyone re-enabling it would want,
       * and a bare `false` gives the next person nothing to reason from.
       */
      enableStashBuffer: true,
      stashInitialSize: 384 * 1024,
      liveBufferLatencyChasing: false,
      liveBufferLatencyMaxLatency: 12,
      liveBufferLatencyMinRemain: 2,
    };
  }

  return {
    ...shared,
    /*
     * Live settings for a screen with a real connection.
     *
     * These used to be the opposite of the television's on every line, on the
     * reasoning that a laptop has bandwidth to spare and should therefore sit as
     * close to the live edge as it can. The first half of that is true and the
     * second half is what made the picture stutter, because of how mpegts.js
     * closes the gap when it decides you have drifted.
     *
     * `liveBufferLatencyChasing` -- which the library's own source calls "not
     * recommended" in the first line of the file that implements it -- answers
     * drift by assigning to `currentTime`. That is a hard seek, and a hard seek
     * on Media Source Extensions tears down the decode pipeline and builds it
     * again: one visible hitch, every time it fires. It is evaluated on every
     * buffered range update, so on every appended fragment, and it fires whenever
     * the buffer is more than `MaxLatency` ahead -- leaving `MinRemain` behind,
     * which was one second. One second of buffer is one jitter spike from an
     * underrun, the underrun refills past six seconds, and it seeks again. That
     * sawtooth is what "choppy" was: not a slow connection and not the provider,
     * but the player repeatedly throwing away the buffer that would have covered
     * for both.
     *
     * So the seek is gone and `liveSync` does the same job the way a live player
     * is supposed to: when it is more than six seconds behind it plays at 1.1x
     * until it is back within three, and then returns to 1x. Nothing is
     * discarded, nothing rebuffers, and 1.1x is slight enough that the pitch
     * shift is not something a viewer notices -- 1.2, the library default, is.
     */
    liveBufferLatencyChasing: false,
    liveSync: true,
    liveSyncMaxLatency: 6,
    liveSyncTargetLatency: 3,
    liveSyncPlaybackRate: 1.1,
    /*
     * And a stash, which is the other half of the same answer.
     *
     * The stash is a read-ahead buffer in front of the demuxer. It was off here
     * because it costs latency, and that was the right trade only while chasing
     * was going to throw the buffer away anyway. A transport stream arriving
     * through the proxy is delivered in bursts -- the provider's pacing, not
     * ours -- and with no stash each burst is demuxed the instant it lands and
     * each gap between bursts is an underrun. A third of the television's stash
     * absorbs the gap; liveSync gives the latency back.
     */
    enableStashBuffer: true,
    stashInitialSize: 128 * 1024,
  };
}
