import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { codecName, mseCandidates, unplayableReason } from '../apps/web/src/client/codecs.js';
import { isTvBrowser, playerConfig, tvBrowserType } from '../apps/web/src/client/tv.js';

/**
 * Why a channel that connects, transfers and then dies says so.
 *
 * "That stream could not be played here. Try VLC." was true and useless. The
 * cause is nearly always the same one and it is nameable: the demuxer handles
 * H.265, AC-3 and E-AC-3 quite happily, repackages them into fMP4, and Media
 * Source Extensions then declines to decode them. A desktop browser has no Dolby
 * licence and often no HEVC path, and it refuses at the source buffer rather than
 * while playing -- so nothing is wrong with the stream, the provider, the line or
 * the proxy, and every one of those got blamed in turn.
 */

/** A browser like desktop Chrome: H.264 and AAC, and nothing more exotic. */
const plainBrowser = (type) => /avc1|mp4a\.40/.test(type);

/**
 * Chromium, answering exactly as it really does.
 *
 * Every line of this was measured in Chrome 152 rather than assumed, because
 * guessing at it is what produced two rounds of channels being refused:
 *
 *   YES audio/mpeg                        YES audio/mp4; codecs="mp4a.40.2"
 *   no  audio/mp4; codecs="mp3"           YES audio/mp4; codecs="mp4a.40.5"
 *   no  audio/mp4; codecs="mp4a.69"       YES audio/mp4; codecs="mp4a.40.29"
 *   no  audio/mp4; codecs="mp4a.40.1"     YES audio/mp4; codecs="opus"
 *   no  audio/mp4; codecs="ac-3" / "ec-3" no  video/mp4; codecs="hvc1…" / "hev1…"
 *
 * Amazon Silk is Chromium, so this is the Fire TV's answer sheet too.
 */
const chromium = (type) =>
  /avc1/.test(type) ||
  /mp4a\.40\.(2|5|29)\b/.test(type) ||
  /codecs="opus"/i.test(type) ||
  type === 'audio/mpeg';

describe('naming a codec', () => {
  test('the names are the ones a person would recognise', () => {
    expect(codecName('hvc1.1.6.L93.B0')).toBe('H.265');
    expect(codecName('ec-3')).toBe('Dolby Digital Plus audio');
    expect(codecName('ac-3')).toBe('Dolby Digital audio');
  });

  test('profile and level suffixes do not leak into the sentence', () => {
    // These vary per channel and mean nothing to a reader.
    expect(codecName('hev1.2.4.L120.90')).toBe('H.265');
  });

  test('an unknown codec is passed through rather than guessed at', () => {
    // Better a mime string the reader can search for than a wrong friendly name.
    expect(codecName('mp4a.something')).toBe('mp4a.something');
    expect(codecName(null)).toBeNull();
  });
});

describe('what this browser can actually decode', () => {
  test('H.264 with AAC is fine and says nothing', () => {
    const reason = unplayableReason(
      { videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.2' },
      plainBrowser,
    );
    expect(reason).toBeNull();
  });

  test('H.265 video is named', () => {
    const reason = unplayableReason(
      { videoCodec: 'hvc1.1.6.L93.B0', audioCodec: 'mp4a.40.2' },
      plainBrowser,
    );
    expect(reason).toContain('H.265');
    expect(reason).toContain('VLC');
  });

  test('Dolby audio on an otherwise playable stream is named', () => {
    // The common one, and the most confusing: the picture would have worked.
    const reason = unplayableReason(
      { videoCodec: 'avc1.64001f', audioCodec: 'ac-3' },
      plainBrowser,
    );
    expect(reason).toContain('Dolby Digital audio');
  });

  test('both halves unplayable reads as one sentence', () => {
    const reason = unplayableReason(
      { videoCodec: 'hvc1.1.6.L93.B0', audioCodec: 'ec-3' },
      plainBrowser,
    );
    expect(reason).toContain('H.265 and Dolby Digital Plus audio');
    // Not two sentences: the reader is going to VLC either way.
    expect(reason.match(/VLC/g).length).toBe(1);
  });

  test('a browser that does support them is not lectured', () => {
    // A Fire TV or an Android TV box has the platform decoders a laptop lacks,
    // and those are exactly the screens this player exists for.
    const tv = () => true;
    expect(unplayableReason({ videoCodec: 'hvc1.1.6.L93.B0', audioCodec: 'ec-3' }, tv)).toBeNull();
  });

  test('a missing half is not reported as unplayable', () => {
    // A radio channel has no video track; a silent feed has no audio one.
    expect(unplayableReason({ videoCodec: 'avc1.64001f' }, plainBrowser)).toBeNull();
    expect(unplayableReason({ audioCodec: 'mp4a.40.2' }, plainBrowser)).toBeNull();
  });

  test('a browser that throws on a codec string is taken as a no', () => {
    const throws = () => {
      throw new TypeError('bad codec');
    };
    expect(unplayableReason({ videoCodec: 'hvc1.1' }, throws)).toContain('H.265');
  });

  test('nothing to go on means nothing to say', () => {
    expect(unplayableReason(null, plainBrowser)).toBeNull();
    expect(unplayableReason({}, plainBrowser)).toBeNull();
  });
});

/**
 * The bug this file existed to prevent, committed by this file's own check.
 *
 * A reader on a Fire TV pressed Play, the channel connected, bytes moved, and the
 * player then tore itself down and said the browser could not decode it. It could.
 * mpegts.js had already rewritten the audio to LC before anything reached Media
 * Source Extensions; the check was asking MSE about the codec the provider's
 * transport stream DECLARED, which is a string MSE is never handed.
 */
describe('what the demuxer declares is not what MSE is handed', () => {
  test('every AAC object type is asked about as LC', () => {
    // The remuxer emits 2 or 5 depending on platform and sampling rate. It never
    // emits what the ADTS header said.
    for (const declared of ['mp4a.40.1', 'mp4a.40.2', 'mp4a.40.5', 'mp4a.40.29']) {
      expect(mseCandidates('audio', declared)).toEqual(['audio/mp4; codecs="mp4a.40.2"']);
    }
  });

  test('MP3 is asked about as a container, not as a codec', () => {
    // The one that was missed first time round. mp4-remuxer sets
    // _mp3UseMpegAudio = !Browser.firefox and then emits container 'audio/mpeg'
    // with the codec field CLEARED, so `audio/mp4; codecs="mp3"` is a string no
    // browser but Firefox is ever handed.
    expect(mseCandidates('audio', 'mp3')).toEqual(['audio/mpeg', 'audio/mp4; codecs="mp3"']);
  });

  test('Opus is asked about in both the spellings Safari cares about', () => {
    // mse-controller rewrites the codec to "Opus" on Safari and leaves it lower
    // case everywhere else.
    expect(mseCandidates('audio', 'opus')).toEqual([
      'audio/mp4; codecs="opus"',
      'audio/mp4; codecs="Opus"',
    ]);
  });

  test('codecs the remuxer passes through are asked about exactly as declared', () => {
    // ts-demuxer sets originalCodec equal to codec for these, and video is never
    // rewritten, so the declared string IS the effective one.
    expect(mseCandidates('audio', 'ac-3')).toEqual(['audio/mp4; codecs="ac-3"']);
    expect(mseCandidates('audio', 'ec-3')).toEqual(['audio/mp4; codecs="ec-3"']);
    expect(mseCandidates('video', 'hvc1.1.6.L93.B0')).toEqual([
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
    ]);
    expect(mseCandidates('video', 'avc1.64001f')).toEqual(['video/mp4; codecs="avc1.64001f"']);
  });

  test('nothing to ask about produces no question', () => {
    expect(mseCandidates('audio', null)).toEqual([]);
    expect(mseCandidates(null, 'mp3')).toEqual([]);
  });

  test('the audio rewrites do not leak onto the video track', () => {
    // A video codec that happened to be spelled like one of these must still be
    // asked about as video/mp4, not quietly turned into audio/mpeg.
    expect(mseCandidates('video', 'mp3')).toEqual(['video/mp4; codecs="mp3"']);
  });

  test('AAC Main plays on Silk instead of being refused', () => {
    // The regression. A provider signalling mp4a.40.1 over ordinary LC payload is
    // the commonest thing in an IPTV playlist, and this said no to all of it.
    const reason = unplayableReason(
      { videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.1' },
      chromium,
    );
    expect(reason).toBeNull();
  });

  test('the other unplayable AAC object types go with it', () => {
    for (const audioCodec of ['mp4a.40.3', 'mp4a.40.4']) {
      expect(unplayableReason({ videoCodec: 'avc1.64001f', audioCodec }, chromium)).toBeNull();
    }
  });

  test('a browser with no AAC at all is still told so, and in words', () => {
    // The check is not being disabled, it is being pointed at the right question.
    const noAac = (type) => /avc1/.test(type);
    const reason = unplayableReason({ videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.1' }, noAac);
    expect(reason).toContain('AAC audio');
    // Not the raw mime string, which is what a reader used to be shown.
    expect(reason).not.toContain('mp4a.40.1');
  });

  test('H.265 and Dolby are unaffected by any of this', () => {
    // They are passed through the remuxer untouched, so the veto still stands and
    // is still the only thing that stops a black rectangle with no explanation.
    expect(unplayableReason({ videoCodec: 'hvc1.1.6.L93.B0' }, chromium)).toContain('H.265');
    expect(unplayableReason({ audioCodec: 'ec-3' }, chromium)).toContain('Dolby');
  });

  test('an MP3 channel plays instead of being sent to VLC', () => {
    // The second report: "This channel is MP3 audio, which this browser cannot
    // decode." It could. Chrome takes audio/mpeg, which is what it is handed.
    const reason = unplayableReason({ videoCodec: 'avc1.64001f', audioCodec: 'mp3' }, chromium);
    expect(reason).toBeNull();
  });

  test('a browser with no MP3 at all is still told so', () => {
    // Neither form supported means the veto is right and the reader needs VLC.
    const noMp3 = (type) => /avc1/.test(type);
    const reason = unplayableReason({ videoCodec: 'avc1.64001f', audioCodec: 'mp3' }, noMp3);
    expect(reason).toContain('MP3 audio');
  });

  test('Firefox takes the MP3 form Chrome refuses, and is not lectured either', () => {
    // The mirror case: audio/mpeg is refused, audio/mp4;codecs="mp3" is taken.
    // Exactly one candidate passes, and one is enough.
    const firefox = (type) => /avc1/.test(type) || type === 'audio/mp4; codecs="mp3"';
    expect(unplayableReason({ videoCodec: 'avc1.64001f', audioCodec: 'mp3' }, firefox)).toBeNull();
  });

  test('MP2 audio is still named MP2 rather than swept up as AAC', () => {
    // mp4a.69 and mp4a.6b are MPEG-2 layer II. They share a prefix with AAC and
    // nothing else, so the order of the name table is load-bearing.
    expect(codecName('mp4a.69')).toBe('MP2 audio');
    expect(codecName('mp4a.6b')).toBe('MP2 audio');
    expect(codecName('mp4a.40.2')).toBe('AAC audio');
    expect(codecName('mp3')).toBe('MP3 audio');
  });
});

/**
 * The other half of "it does not play on Silk", which was never a codec at all.
 *
 * The player was tuned for a laptop: no read-ahead buffer, and latency chasing on.
 * On a stick behind household wifi that pair turns every jitter spike into a
 * visible stall and then answers the stall with a forward seek, which is another
 * stall. The settings are picked per screen now.
 */
describe('the buffering profile follows the screen', () => {
  const FIRE_TV =
    'Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7233; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/70.0.3538.110 Safari/537.36';
  const FIRE_TABLET =
    'Mozilla/5.0 (Linux; Android 9; KFMAWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/107.3.1 like Chrome/107.0.5304.141 Safari/537.36';
  const DESKTOP =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  const PHONE =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

  test('a Fire TV is recognised by its model, not by the word Silk', () => {
    // Some Fire TV builds send a plain Chrome user agent with no "Silk" in it at
    // all, so the AFT model string is the marker that actually holds.
    expect(tvBrowserType(FIRE_TV)).toBe('firetv');
    expect(tvBrowserType(FIRE_TABLET)).toBe('silk');
  });

  test('a laptop and an Android phone are not televisions', () => {
    expect(isTvBrowser(DESKTOP)).toBe(false);
    expect(isTvBrowser(PHONE)).toBe(false);
    expect(isTvBrowser('')).toBe(false);
    expect(isTvBrowser(undefined)).toBe(false);
  });

  test('every screen gets the same profile now', () => {
    /*
     * The split was the bug, so this is the rule worth pinning.
     *
     * A television was given a read-ahead buffer and no latency chasing, and it
     * worked. A desktop was given the exact opposite on the theory that a laptop
     * has bandwidth to spare -- and bandwidth was never what was wrong. These
     * are media-streamer's live TV numbers, which survive an evening on the same
     * provider lines this player was dying on.
     */
    expect(playerConfig(false)).toEqual(playerConfig(true));
  });

  test('nothing closes drift by seeking', () => {
    /*
     * liveBufferLatencyChasing assigns to currentTime. That is a hard seek, MSE
     * rebuilds the decode pipeline on every one, it is evaluated on every
     * appended fragment, and it leaves only liveBufferLatencyMinRemain seconds
     * of buffer behind -- one second, as it was set. One second is a single
     * jitter spike from an underrun; the underrun refills past the ceiling; it
     * seeks again. Each hitch was also a chance to spend a restart, which is how
     * a stutter turned into a stream that ended.
     */
    expect(playerConfig(false).liveBufferLatencyChasing).toBe(false);
  });

  test('every screen reads ahead rather than demuxing whatever just landed', () => {
    // A transport stream arrives in bursts regardless of the viewer's
    // bandwidth, so with nothing in front of the demuxer every gap between
    // bursts is an underrun. On a desktop this was 128 *bytes*.
    const config = playerConfig(false);
    expect(config.enableStashBuffer).toBe(true);
    expect(config.stashInitialSize).toBe(384 * 1024);
  });

  test('the demuxer does NOT run off the main thread', () => {
    /*
     * A regression test with a real outage behind it.
     *
     * `enableWorker: true` reads like free performance and media-streamer's
     * live TV player does set it, so it was copied over -- and every stream
     * stopped playing. mpegts.js builds its worker by stringifying
     * `__webpack_modules__`, webpack's internal module registry. media-streamer
     * is Next.js, so that global is there. This bundle is built by Bun, so it
     * is not, and the worker is broken.
     *
     * The failure is silent: Transmuxer's try/catch only sees a SYNCHRONOUS
     * throw, and a Worker that constructs from a bad blob fails asynchronously.
     * Nothing throws, nothing falls back to inline transmuxing, no init segment
     * ever arrives, and the player reports no error at all.
     *
     * Do not turn this on again without changing how this file is bundled.
     */
    expect(playerConfig(false).enableWorker).toBe(false);
  });

  test('both profiles still drop what has been watched, and never idle', () => {
    // Without the cleanup a three hour match fills the source buffer and the tab
    // is killed -- soonest on exactly the device this is all for. lazyLoad would
    // drop the provider connection mid-match, on a line that permits one.
    for (const config of [playerConfig(true), playerConfig(false)]) {
      expect(config.autoCleanupSourceBuffer).toBe(true);
      expect(config.lazyLoad).toBe(false);
    }
  });
});

/**
 * When the restart budget comes back, which is what "the stream dies after a
 * minute or two" turned out to mean.
 */
describe('the restart budget', () => {
  const entry = readFileSync(
    new URL('../apps/web/src/client/player-entry.js', import.meta.url).pathname,
    'utf8',
  );

  test('a picture refills it', () => {
    /*
     * It used to refill only after thirty unbroken seconds, measured from the
     * last restart and checked solely from inside the stall watcher. Three
     * hiccups inside half a minute therefore spent the whole allowance and the
     * channel was given up on for good -- even though all three restarts had
     * worked and the picture was back within seconds each time. On a provider
     * line that drops a connection now and then, that is a hard ceiling of
     * three recoveries per stream, about a minute's worth.
     */
    expect(entry).toMatch(/const onPlaying = \(\) => \{\s*restarts = 0;/);
    expect(entry).not.toContain('RECOVERED_AFTER_MS');
  });

  test('a channel that never plays is still given up on', () => {
    // The budget is spent by failures to RECOVER, not by failures. Nothing ever
    // fires `playing` for a channel that never starts, so the bound still holds.
    expect(entry).toMatch(/const MAX_RESTARTS = 5;/);
    expect(entry).toContain('if (restarts >= MAX_RESTARTS) return giveUp(finalMessage);');
  });
});

/**
 * Pressing Play means "show me the match", which is a full screen with the
 * sound on rather than a muted rectangle in a list.
 */
describe('what pressing Play does to the screen', () => {
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url).pathname, 'utf8');

  test('it goes fullscreen', () => {
    expect(app).toContain('goFullscreen(video)');
  });

  test('it fullscreens the video, not the stage around it', () => {
    /*
     * The stage holds nothing but the video, so the two look equivalent. They
     * are not: the control bar's minimise button is a toggle on the VIDEO's
     * fullscreen state, so with the stage as the fullscreen element the video
     * does not consider itself fullscreen, the button offers to enter rather
     * than leave, and pressing it appears to do nothing. Escape still worked,
     * because Escape exits whatever is fullscreen -- which is exactly what
     * "the minimise button does nothing, I have to hit Esc" is.
     *
     * The stage is the wrong box to blow up anyway: it carries
     * `aspect-ratio: 16 / 9` and `overflow: hidden` so the page does not jump
     * before the first frame, neither of which should be fighting a fullscreen
     * element for the shape of the screen.
     */
    expect(app).toMatch(/video\.requestFullscreen \?\? video\.webkitRequestFullscreen/);
    expect(app).not.toContain('stage.requestFullscreen');
  });

  test('it still starts muted, and unmutes only once there is a picture', () => {
    /*
     * Autoplay policy refuses audible video without a gesture, and the refusal
     * is a rejected play() that leaves a black rectangle -- which reads as a
     * broken stream. The click IS a gesture, but the handler awaits the player
     * bundle first and a cold fetch can outlast the activation, so the sound
     * goes up on the first `playing` instead.
     */
    expect(app).toContain('video.muted = true');
    expect(app).toMatch(/video\.volume = 1;\s*video\.muted = false;/);
  });

  test('a browser that refuses the sound keeps the picture', () => {
    // Chrome answers an unwanted unmute by pausing, not by throwing, so the
    // paused element is the only signal there is.
    expect(app).toMatch(/if \(video\.paused\) \{\s*video\.muted = true;/);
  });
});

describe('the player asks at the right moment', () => {
  const entry = readFileSync(
    new URL('../apps/web/src/client/player-entry.js', import.meta.url).pathname,
    'utf8',
  );

  test('the check hangs off media info, not off the button', () => {
    // Nothing about a channel says what is inside it until the demuxer has read
    // the stream: the playlist gives a name and a URL, the response gives
    // video/mp2t, and a transport stream carries whatever was put in it.
    expect(entry).toContain('mpegts.Events.MEDIA_INFO');
    expect(entry).toMatch(/unplayableReason\(\s*info\b/);
  });

  test('the failure detail is no longer dropped on the floor', () => {
    // It is the only thing separating "this browser will not decode Dolby" from
    // "the stream is malformed", and it was being discarded.
    // A regex, not a string literal: writing the placeholder as text trips the
    // lint rule that looks for accidental template interpolation.
    expect(entry).toMatch(/That stream could not be played here \(\$\{detail\}\)/);
  });

  test('the profile is chosen from the user agent, not baked in', () => {
    // The settings used to be a literal in the createPlayer call, which is how a
    // laptop's tuning came to be what a Fire TV got.
    expect(entry).toContain('playerConfig(isTvBrowser(navigator.userAgent))');
  });
});
