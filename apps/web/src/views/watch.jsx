import { brand } from '@tipoff/config';
import { assetUrl } from '../lib/asset-version.js';
import { Layout } from './Layout.jsx';

/**
 * Watching a news channel.
 *
 * The rest of this site answers "when is it on" and then "where can I watch
 * it". News has no answer to the first and a strange answer to the second: you
 * cannot tune in to an article. What you can do is watch the desk -- so a
 * channel page is its own destination here rather than something hanging off an
 * event, and every section and outlet page links into it.
 */

const label = (c) => [c.country, c.quality].filter(Boolean).join(' · ');

export const ChannelList = ({ channels, heading, blurb }) =>
  channels.length === 0 ? null : (
    <section class="channels">
      <h2>{heading}</h2>
      {blurb ? <p class="muted">{blurb}</p> : null}
      <ul class="leagues">
        {channels.map((c) => (
          <li>
            <a href={`/watch/${c.id}`}>
              <strong>{c.name}</strong>
              {label(c) ? <span class="muted">{label(c)}</span> : null}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );

export const WatchIndex = ({ user, channels }) => (
  <Layout
    title="Watch the news"
    user={user}
    canonical="/watch"
    description={`Live news channels you can watch in the page, free and without an account. ${brand.name}.`}
  >
    <h1>Watch</h1>
    <p class="muted">
      Live news channels, playing here rather than somewhere else. No account, and nothing to
      install.
    </p>
    <ChannelList channels={channels} heading="On now" />
  </Layout>
);

export const WatchChannel = ({ user, channel, also }) => (
  <Layout
    title={`${channel.name} live`}
    user={user}
    canonical={`/watch/${channel.id}`}
    description={`Watch ${channel.name} live${channel.country ? ` from ${channel.country}` : ''}, free and in the page.`}
  >
    <ol class="crumbs" aria-label="Breadcrumb">
      <li>
        <a href="/watch">Watch</a>
      </li>
      <li aria-current="page">{channel.name}</li>
    </ol>
    <h1>{channel.name}</h1>

    {/* The player is progressive: the <video> is real markup, and the script
        upgrades it. Safari plays HLS natively and needs no library at all, so
        the fallback is a working player rather than a black rectangle. */}
    <div class="player">
      <video
        id="channel-player"
        controls
        autoplay
        playsinline
        muted
        data-src={`/watch/${channel.id}/index.m3u8`}
        poster=""
      >
        <track kind="captions" />
      </video>
      <p class="muted" data-player-note>
        Starting…
      </p>
    </div>

    <p class="muted">
      {[channel.network, channel.country, channel.quality].filter(Boolean).join(' · ')}
      {channel.website ? (
        <>
          {' · '}
          <a href={channel.website} rel="noopener nofollow">
            Official site
          </a>
        </>
      ) : null}
    </p>
    <p class="muted">
      Streamed from the channel's own public feed. {brand.name} does not host it, and a channel that
      stops working here has usually stopped working at the source.
    </p>

    <ChannelList channels={also} heading="Also on" />
    <script src={assetUrl('/vendor-hls.js')} defer />
    <script src={assetUrl('/watch.js')} defer />
  </Layout>
);
