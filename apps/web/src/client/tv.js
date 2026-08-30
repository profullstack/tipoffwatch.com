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
export function playerConfig(_isTv) {
  return {
    /*
     * Demux on a worker thread.
     *
     * A transport stream at broadcast bitrate is real work, and on the main
     * thread it competes with rendering the page it is playing on -- which
     * shows up as dropped frames rather than as an error. mpegts.js builds the
     * worker from a blob URL; we serve no CSP, so there is nothing to allow.
     */
    enableWorker: true,

    /*
     * Read ahead, on every screen.
     *
     * The stash sits in front of the demuxer. A transport stream arrives in
     * bursts -- the provider's pacing, not the viewer's bandwidth -- so with
     * nothing buffered each gap between bursts is an underrun however fast the
     * connection is. 384KB is mpegts.js's own default, roughly a second.
     */
    enableStashBuffer: true,
    stashInitialSize: 384 * 1024,

    /*
     * Never close drift by seeking.
     *
     * This is the line that made a desktop stutter and then killed the stream.
     * mpegts.js implements chasing by assigning to `currentTime`; that is a
     * hard seek, MSE rebuilds the decode pipeline on every one, it is evaluated
     * on every appended fragment, and it leaves only `MinRemain` seconds of
     * buffer behind -- one second, as this used to be set. One second is a
     * single jitter spike from an underrun, the underrun refills past the
     * ceiling, and it seeks again. Each hitch was also a chance to spend a
     * restart, which is how a stutter became a stream that ended.
     *
     * The two bounds are inert while chasing is off. They are kept as the bound
     * anyone re-enabling it would want, rather than left to a library default.
     */
    liveBufferLatencyChasing: false,
    liveBufferLatencyMaxLatency: 5,
    liveBufferLatencyMinRemain: 1,

    /*
     * Drop what has already been watched. Without this the source buffer keeps
     * every second of a three-hour match in memory and the tab is killed -- on
     * a Fire TV, considerably sooner than that.
     */
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 30,
    autoCleanupMinBackwardDuration: 10,

    /*
     * lazyLoad pauses the download once enough is buffered, which on a live
     * stream means dropping the provider connection mid-match and reconnecting
     * -- on a line that permits one connection, the worst available way to
     * idle. Off, with both durations stated so there is no default to inherit.
     */
    lazyLoad: false,
    lazyLoadMaxDuration: 60,
    lazyLoadRecoverDuration: 30,

    seekType: 'range',
  };
}
