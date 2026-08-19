import { html } from 'hono/html';
import { config } from '@tipoff/config';

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
      <title>{props.title ? `${props.title} · TipoffWatch` : 'TipoffWatch — never miss a game'}</title>
      <meta name="description" content={props.description ?? 'Follow any team in the world and get told before they play. Free.'} />
      <meta name="theme-color" content="#0b0f17" />
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      <link rel="stylesheet" href="/styles.css" />
      {props.canonical ? <link rel="canonical" href={`${config.siteUrl}${props.canonical}`} /> : null}
      <meta property="og:title" content={props.title ?? 'TipoffWatch'} />
      <meta property="og:type" content="website" />
    </head>
    <body>
      <a class="skip" href="#main">Skip to content</a>
      <header class="topbar">
        <a class="brand" href="/">
          <span class="brand-mark" aria-hidden="true" />
          <span>TipoffWatch</span>
        </a>
        <nav>
          <a href="/sports">Sports</a>
          {props.user ? <a href="/following">My games</a> : null}
          {props.user ? (
            <a href="/settings">Settings</a>
          ) : (
            <a class="cta" href="/login">Sign in</a>
          )}
        </nav>
      </header>

      <main id="main">{props.children}</main>

      <footer>
        <p>
          TipoffWatch is free. Schedules refresh continuously; times are shown in{' '}
          {props.user?.timezone ?? 'your local time'}.
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
