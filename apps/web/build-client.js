import { dirname } from 'node:path';

/**
 * Bundles the browser helpers into public/ as globals.
 *
 * Bundled rather than pulled from a CDN: the page must keep working under a strict
 * CSP and with no third-party origin in the critical path of signing in.
 *
 * Two bundles rather than one, and deliberately so. The WebAuthn helper is small
 * and loads on every page; the player carries a whole MPEG-2 transport stream
 * demuxer and loads only when somebody presses play. Merging them would put a few
 * hundred kilobytes on every page view to serve the handful that watch.
 */
const BUNDLES = [
  ['webauthn-entry.js', 'vendor-webauthn.js'],
  ['player-entry.js', 'vendor-mpegts.js'],
  // The house player with its control bar, for radio. A third bundle rather than
  // a second entry in the second: a reader pressing Play on a channel row must
  // not download hls.js, and one pressing Play on a station must not download
  // the transport stream demuxer.
  ['radio-entry.js', 'vendor-player.js'],
];

/*
 * The player's stylesheet ships beside its script, copied out of the package so
 * a version bump is one place. Fetched by app.js with the bundle, never linked
 * by the Layout: it styles a bar that most pages never draw.
 */
const PLAYER_CSS = [
  new URL('../../node_modules/@profullstack/player/dist/player.css', import.meta.url),
  new URL('./node_modules/@profullstack/player/dist/player.css', import.meta.url),
];

/*
 * What the radio bundle leaves out.
 *
 * The player loads its engines on demand, and a bundler with no code splitting
 * answers a dynamic import by inlining it -- so the first build of this bundle
 * carried hls.js AND the transport stream demuxer, 900KB for a page that only
 * ever plays HLS. mpegts.js is marked external (the import stays a bare
 * specifier that is never reached for an HLS source), and hls.js is swapped for
 * its light build, which drops subtitles, DRM and alternate audio tracks. A
 * radio station has none of those.
 */
const hlsLight = {
  name: 'hls-light',
  setup(build) {
    // Resolved from the importer, not from here: hls.js is the player's own
    // dependency and Bun's isolated linker does not hoist it to this package.
    build.onResolve({ filter: /^hls\.js$/ }, (args) => ({
      path: Bun.resolveSync('hls.js/dist/hls.light.mjs', dirname(args.importer)),
    }));
  },
};
const RADIO_ONLY = { external: ['mpegts.js'], plugins: [hlsLight] };

for (const [entry, name] of BUNDLES) {
  const out = await Bun.build({
    entrypoints: [new URL(`./src/client/${entry}`, import.meta.url).pathname],
    outdir: new URL('./public', import.meta.url).pathname,
    naming: name,
    minify: true,
    target: 'browser',
    ...(entry === 'radio-entry.js' ? RADIO_ONLY : {}),
  });
  if (!out.success) {
    for (const l of out.logs) console.error(l);
    process.exit(1);
  }
  console.log(`[build] ${name}`);
}

for (const candidate of PLAYER_CSS) {
  const file = Bun.file(candidate.pathname);
  if (!(await file.exists())) continue;
  await Bun.write(new URL('./public/vendor-player.css', import.meta.url).pathname, file);
  console.log('[build] vendor-player.css');
  break;
}
