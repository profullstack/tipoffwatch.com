import { assetUrl } from '../lib/asset-version.js';
import { Layout } from './Layout.jsx';

/**
 * Several of the reader's own channels on one screen.
 *
 * The page is a grid of tiles and very little else. Each tile is one channel
 * row from the reader's own list, addressed by id, and plays through the same
 * proxy route the Play button on an event page uses -- so nothing here has a
 * credential in it, and a tile is exactly as private as that button.
 *
 * The number that matters is in `data-max`: how many streams this line may hold
 * open at once. It is the line's own figure (the provider's panel, lowered by
 * the reader in settings if they like), and app.js will not start a tile past
 * it. The server enforces the same number, and past it the OLDEST stream is
 * evicted -- which on this page would look like tile one going black when tile
 * three starts. Refusing here is kinder than explaining that afterwards.
 *
 * Everything interactive is added by app.js. Without it the page still lists
 * the tiles and says what the line permits; it simply cannot play, which is the
 * same as the event page without it.
 */

const Tile = ({ tile }) => (
  <article
    class="mv-tile"
    data-mv-tile-id={tile.id}
    data-play={`/my/channels/${tile.id}/stream.ts`}
  >
    <div class="mv-screen">
      <p class="mv-state muted small">Waiting for the player…</p>
    </div>
    <div class="mv-bar">
      <span class="mv-title" title={tile.title}>
        {tile.title}
        {tile.group ? <span class="league-tag channel-tag">{tile.group}</span> : null}
      </span>
      <span class="mv-actions">
        <button type="button" class="ghost small-btn" data-mv-sound aria-pressed="false">
          Sound
        </button>
        <button type="button" class="ghost small-btn" data-mv-toggle>
          Stop
        </button>
        <button type="button" class="ghost small-btn" data-mv-remove aria-label="Remove this tile">
          ✕
        </button>
      </span>
    </div>
  </article>
);

const permits = (allowance, panelConnections) => {
  const line =
    allowance === 1
      ? 'Your line permits one stream at a time'
      : `Your line permits ${allowance} streams at once`;
  if (panelConnections === null || panelConnections === undefined) {
    return `${line}. Your provider did not say how many it allows, so it is set in settings.`;
  }
  if (panelConnections === allowance) return `${line}, which is what your provider reports.`;
  return `${line}. Your provider reports ${panelConnections}; you lowered it in settings.`;
};

export const Multiview = ({
  user,
  hasList,
  tiles = [],
  allowance = 1,
  panelConnections = null,
  maxTiles = 4,
  live = [],
  playerEnabled = true,
}) => (
  <Layout
    title="Multiview"
    user={user}
    noindex
    description="Watch up to four channels from your own line on one screen."
  >
    <section
      class="multiview"
      data-multiview
      data-max={allowance}
      data-max-tiles={maxTiles}
      data-mv-player-src={assetUrl('vendor-mpegts.js')}
      data-search="/api/my/channels/search"
    >
      <div class="mv-head">
        <h1>Multiview</h1>
        {!hasList ? (
          <p class="empty">
            Multiview plays channels from your own list. <a href="/settings">Add one in settings</a>{' '}
            first.
          </p>
        ) : !playerEnabled ? (
          <p class="empty">Playing in the page is switched off right now.</p>
        ) : (
          <>
            <p class="muted small">
              Up to {maxTiles} channels from your own line on one screen, side by side. Pop it out
              and the grid stays on top of whatever else you are doing.{' '}
              {permits(allowance, panelConnections)} <a href="/settings#line">Change that</a>.
            </p>
            <div class="mv-controls">
              <form class="mv-search" data-mv-search-form action="/search" method="get">
                <input
                  class="input"
                  type="search"
                  name="q"
                  placeholder="Add a channel from your list…"
                  autocomplete="off"
                  aria-label="Find a channel on your list"
                />
                <button type="submit" class="ghost small-btn">
                  Find
                </button>
              </form>
              <button type="button" class="cta small-btn" data-mv-popout>
                Pop out
              </button>
            </div>
            <ul class="mv-results" data-mv-results />
          </>
        )}
      </div>

      {hasList && playerEnabled ? (
        <div class="mv-stage">
          <div class="mv-grid" data-mv-grid data-count={tiles.length}>
            {tiles.map((tile) => (
              <Tile tile={tile} />
            ))}
          </div>
          <p class={`mv-empty muted${tiles.length ? ' is-hidden' : ''}`} data-mv-empty>
            No tiles yet. Find a channel above, or press <strong>Multiview</strong> beside a channel
            on any game page to add it here.
          </p>
        </div>
      ) : null}

      {/* The markup app.js stamps out for a tile added on this page. Kept beside
          the server-rendered tiles rather than duplicated in JavaScript, so a
          change to one cannot leave the other behind. */}
      <template data-mv-tile>
        <Tile tile={{ id: 0, title: '', group: null }} />
      </template>
    </section>

    {hasList && live.length > 0 ? (
      <section class="mv-live">
        <h2>Live now</h2>
        <p class="muted small">Open a game and press Multiview beside a channel that carries it.</p>
        <ul class="mv-live-list">
          {live.map((e) => (
            <li>
              <a href={`/events/${e.id}`}>{e.short_name ?? e.name}</a>
              {e.league_name ? <span class="league-tag">{e.league_name}</span> : null}
            </li>
          ))}
        </ul>
      </section>
    ) : null}
  </Layout>
);
