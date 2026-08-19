import { config } from '@tipoff/config';
import { html } from 'hono/html';

/**
 * The single HTML shell. Everything renders through here, including the signed-out
 * landing page -- a second shell is how site-wide tags end up missing for exactly
 * the visitors who matter most.
 */
export const Layout = (props) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>
        {props.title ? `${props.title} · TipoffWatch` : 'TipoffWatch — never miss a game'}
      </title>
      <meta
        name="description"
        content={
          props.description ?? 'Follow any team in the world and get told before they play. Free.'
        }
      />
      {/* Matches the stylesheet's ground so browser chrome and the PWA splash do
          not flash white before a dark page paints. */}
      <meta name="theme-color" content="#12161f" />
      <link rel="manifest" href="/manifest.webmanifest" />

      {/* Deliberately NOT linking the 1254x1254 /favicon.png the generator emits:
          it is the same 1.4MB source image as the logo, and browsers would fetch it
          on every page to draw a 16px tab icon. The generated sizes are the point. */}
      <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
      <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
      <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180x180.png" />
      <link rel="apple-touch-icon" sizes="152x152" href="/icons/apple-touch-icon-152x152.png" />
      <link rel="apple-touch-icon" sizes="144x144" href="/icons/apple-touch-icon-144x144.png" />
      <link rel="apple-touch-icon" sizes="120x120" href="/icons/apple-touch-icon-120x120.png" />
      <link rel="apple-touch-icon" sizes="76x76" href="/icons/apple-touch-icon-76x76.png" />

      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      <meta name="apple-mobile-web-app-title" content="Tipoff" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="msapplication-TileColor" content="#12161f" />
      <meta name="msapplication-config" content="/icons/browserconfig.xml" />
      <meta name="msapplication-TileImage" content="/icons/apple-touch-icon-144x144.png" />

      <link rel="stylesheet" href="/styles.css" />
      {props.canonical ? (
        <link rel="canonical" href={`${config.siteUrl}${props.canonical}`} />
      ) : null}
      <meta property="og:title" content={props.title ?? 'TipoffWatch'} />
      <meta property="og:type" content="website" />
      <meta property="og:image" content={`${config.siteUrl}/icons/icon-512x512.png`} />
      <meta name="twitter:card" content="summary" />
    </head>
    {/* Carries the zone the server has on file, so app.js can report a correction
        from any page rather than only from settings -- someone who never opens
        settings would otherwise get every reminder email stamped in UTC. */}
    {/* data-tz is the zone the visitor CHOSE, and wins over the browser's when set:
        a setting that does not change what you see is not a setting. data-known-tz
        is what the server currently has on file, so the client only reports a
        correction when it genuinely differs. */}
    <body
      data-tz={props.user?.timezone ?? null}
      data-known-tz={props.user ? (props.user.timezone ?? 'UTC') : null}
    >
      <a class="skip" href="#main">
        Skip to content
      </a>
      <header class="topbar">
        {/* The mark carries the name, so the wordmark beside it was saying the
            same thing twice. alt keeps it for anyone not seeing the image. */}
        <a class="brand" href="/">
          <img
            src="/icons/icon-192x192.png"
            alt="TipoffWatch"
            width="192"
            height="192"
            class="brand-logo"
          />
        </a>
        <nav>
          <a href="/sports">Sports</a>
          {props.user ? <a href="/following">My games</a> : null}
          {props.user ? (
            <a href="/settings">Settings</a>
          ) : (
            <a class="cta" href="/login">
              Sign in
            </a>
          )}
        </nav>
      </header>

      <main id="main">{props.children}</main>

      <footer>
        <p>
          TipoffWatch is free. Times are shown in your own time zone (
          <span data-tz-label>your device</span>).
        </p>
        <p class="muted">
          Schedule data from{' '}
          <a href="https://www.espn.com" rel="noopener nofollow">
            ESPN
          </a>
          's public API. Not affiliated with ESPN.
        </p>
        <p class="muted">
          <a href="/sports">Browse sports</a> · <a href="/about">About</a> ·{' '}
          <a href="/api/v1">Public API</a>
        </p>
      </footer>

      {/* Registers the service worker and wires the push opt-in. Everything on the
          site works without this file -- it only adds notifications. */}
      <script src="/vendor-webauthn.js" defer />
      <script src="/app.js" defer />
      {props.vapidKey ? html`<script>window.__VAPID = "${props.vapidKey}";</script>` : null}
    </body>
  </html>
);
