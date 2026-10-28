import { LocalTime } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * /settings/webhooks: the reader's endpoints, their signing secrets, a test
 * button, the delivery log, and the personal API key the same features answer
 * to at /api/v1/webhooks.
 *
 * Every control is a plain form, like the rest of settings. A secret or a key
 * is shown exactly once, on the response to the form that made it; nothing
 * reads it back onto the page later.
 */

const when = (ms) => (Number.isFinite(ms) ? <LocalTime at={ms} /> : null);

export const WebhooksPage = ({
  user,
  site,
  endpoints = [],
  deliveries = [],
  eventTypes = [],
  descriptions = {},
  caps = {},
  apiKey = null,
  reveal = null,
  notice = null,
  error = null,
}) => (
  <Layout title="Webhooks" user={user}>
    <h1>Webhooks</h1>
    <p class="muted">
      Your server gets a signed POST when something happens to a game you follow. Each one is a{' '}
      <a href="https://cloudevents.io/">CloudEvent</a> signed per{' '}
      <a href="https://www.standardwebhooks.com/">Standard Webhooks</a> (<code>webhook-id</code>,{' '}
      <code>webhook-timestamp</code>, <code>webhook-signature</code>), retried with backoff for
      about three days. Only https addresses on the public internet are accepted.
    </p>

    {notice ? (
      <p class="feedback ok" role="status">
        {notice}
      </p>
    ) : null}
    {error ? (
      <p class="feedback error" role="alert">
        {error}
      </p>
    ) : null}

    {reveal ? (
      <section class="card" id="reveal">
        <h2>{reveal.title}</h2>
        <p class="muted small">Copy it now. It is not shown again.</p>
        <p>
          <code class="secret">{reveal.value}</code>
        </p>
      </section>
    ) : null}

    <section id="endpoints">
      <h2>Your endpoints</h2>
      {endpoints.length === 0 ? <p class="muted">None yet.</p> : null}
      {endpoints.map((e) => (
        <div class="card">
          <p>
            <strong>{e.url}</strong>
            {e.description ? <span class="muted"> {e.description}</span> : null}
          </p>
          <p class="muted small">
            Events: {e.events.join(', ')}. {e.enabled ? 'On' : 'Off'}
            {e.disabled_reason ? ` (${e.disabled_reason})` : ''}
            {e.failures ? `, ${e.failures} failures in a row` : ''}.
          </p>
          <form method="post" action={`/settings/webhooks/${e.id}/test`} class="inline">
            <button type="submit" class="ghost small-btn">
              Send a test
            </button>
          </form>{' '}
          <form method="post" action={`/settings/webhooks/${e.id}/rotate`} class="inline">
            <button type="submit" class="ghost small-btn">
              New secret
            </button>
          </form>{' '}
          <form method="post" action={`/settings/webhooks/${e.id}/toggle`} class="inline">
            <input type="hidden" name="enabled" value={e.enabled ? '0' : '1'} />
            <button type="submit" class="ghost small-btn">
              {e.enabled ? 'Turn off' : 'Turn on'}
            </button>
          </form>{' '}
          <form method="post" action={`/settings/webhooks/${e.id}/delete`} class="inline">
            <button type="submit" class="ghost small-btn">
              Remove
            </button>
          </form>
        </div>
      ))}
    </section>

    <section id="add">
      <h2>Add an endpoint</h2>
      <form method="post" action="/settings/webhooks" class="card">
        <label class="field">
          <span>URL</span>
          <input type="url" name="url" required placeholder="https://example.com/hooks/tipoff" />
        </label>
        <label class="field">
          <span>Note (optional)</span>
          <input type="text" name="description" maxlength={200} />
        </label>
        <fieldset>
          <legend>Events (none ticked means all of them)</legend>
          {eventTypes.map((t) => (
            <label class="check">
              <input type="checkbox" name="events" value={t} /> <code>{t}</code>{' '}
              <span class="muted small">{descriptions[t]}</span>
            </label>
          ))}
        </fieldset>
        <button class="cta" type="submit">
          Add endpoint
        </button>
      </form>
      <p class="muted small">
        Line moves are capped at {caps['line.moved']} an hour per account, everything else at{' '}
        {caps['game.final']}; past that the rest of the hour is skipped, not queued.
      </p>
    </section>

    <section id="deliveries">
      <h2>Recent deliveries</h2>
      {deliveries.length === 0 ? (
        <p class="muted">Nothing sent yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Status</th>
              <th>Tries</th>
              <th>Last answer</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr>
                <td>
                  <code>{d.event_type}</code>
                </td>
                <td>{d.status}</td>
                <td>{d.attempts}</td>
                <td>{d.last_status ?? d.last_error ?? ''}</td>
                <td>{when(Date.parse(d.created_at))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section id="api-key">
      <h2>API key</h2>
      <p class="muted">
        The same endpoints are at <code>{site}/api/v1/webhooks</code> for scripts and agents, with{' '}
        <code>Authorization: Bearer &lt;key&gt;</code>.
      </p>
      {apiKey ? (
        <p class="muted small">
          Your key ends in <code>{apiKey.hint}</code>, made {when(Date.parse(apiKey.created_at))}
          {apiKey.last_used_at ? (
            <>, last used {when(Date.parse(apiKey.last_used_at))}</>
          ) : (
            ', never used'
          )}
          .
        </p>
      ) : (
        <p class="muted small">You have no key.</p>
      )}
      <form method="post" action="/settings/webhooks/key" class="inline">
        <button type="submit" class="ghost">
          {apiKey ? 'Replace key' : 'Make a key'}
        </button>
      </form>{' '}
      {apiKey ? (
        <form method="post" action="/settings/webhooks/key/revoke" class="inline">
          <button type="submit" class="ghost">
            Revoke
          </button>
        </form>
      ) : null}
      <pre class="small">{`curl -H "Authorization: Bearer $KEY" ${site}/api/v1/webhooks
curl -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"url":"https://example.com/hook","events":["game.final"]}' ${site}/api/v1/webhooks`}</pre>
    </section>
  </Layout>
);
