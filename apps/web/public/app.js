/* Progressive enhancement only. Every control on this site already works as a plain
   form; this file localises times and adds push notifications and passkeys where the
   browser has them. */

/* ------------------------------------------------------------ local time -- */

/**
 * Rewrite server-rendered UTC times into the viewer's own zone.
 *
 * Schedule pages are cached in Redis and served byte-identical to everyone, so the
 * server cannot bake in a per-viewer timezone. It emits UTC plus a machine-readable
 * `datetime`, and this rewrites the visible text. With JavaScript off the page still
 * shows a correct time, labelled UTC.
 */
function localiseTimes(root = document) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  for (const el of root.querySelectorAll('time[data-local]')) {
    const at = new Date(el.getAttribute('datetime'));
    if (Number.isNaN(+at)) continue;
    const t = el.querySelector('[data-local-time]');
    const d = el.querySelector('[data-local-day]');
    if (t) t.textContent = time.format(at);
    if (d) d.textContent = day.format(at);
    el.title = `${at.toLocaleString()} (${zone})`;
  }

  for (const el of document.querySelectorAll('[data-tz-label]')) el.textContent = zone;
}

/**
 * Tell the server which zone we are in, once.
 *
 * Email reminders are rendered on a server with no browser, so they need a stored
 * zone or they go out in UTC and look an hour or eight wrong. Only sent when it
 * actually differs from what the server already has.
 */
async function reportTimezone() {
  const el = document.querySelector('[data-known-tz]');
  if (!el) return;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || zone === el.getAttribute('data-known-tz')) return;
  await fetch('/api/timezone', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ timezone: zone }),
  }).catch(() => {});
}

/* --------------------------------------------------------------- helpers -- */

const postJson = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Say what happened. The passkey button used to fail in total silence. */
function say(el, message, kind = 'info') {
  if (!el) return;
  el.textContent = message;
  el.className = `feedback ${kind}`;
  el.hidden = false;
}

/* ------------------------------------------------------------------ push -- */

const urlB64ToUint8Array = (b64) => {
  const padded = (b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

async function registerSw() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('sw registration failed', err);
    return null;
  }
}

async function initPush() {
  const box = document.getElementById('push-optin');
  const btn = document.getElementById('enable-push');
  if (!box || !btn) return;

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && window.__VAPID;
  if (!supported) return;

  const reg = await registerSw();
  if (!reg) return;

  const existing = await reg.pushManager.getSubscription();
  if (existing || Notification.permission === 'denied') return;
  box.hidden = false;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if ((await Notification.requestPermission()) !== 'granted') return;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(window.__VAPID),
      });
      const res = await postJson('/api/push/subscribe', sub.toJSON());
      if (res.ok) box.innerHTML = '<p class="ok">Notifications are on.</p>';
    } finally {
      btn.disabled = false;
    }
  });
}

/* -------------------------------------------------------------- passkeys -- */

async function initPasskeys() {
  const { startAuthentication, startRegistration } = window.SimpleWebAuthnBrowser ?? {};

  const signin = document.getElementById('passkey-signin');
  const signinMsg = document.getElementById('passkey-signin-msg');
  if (signin) {
    if (!window.PublicKeyCredential || !startAuthentication) {
      signin.hidden = true;
    } else {
      signin.addEventListener('click', async () => {
        signin.disabled = true;
        try {
          const options = await (await postJson('/api/auth/passkey/authenticate/options')).json();
          const asseResp = await startAuthentication({ optionsJSON: options });
          const res = await postJson('/api/auth/passkey/authenticate/verify', asseResp);
          if (res.ok) {
            location.href = '/following';
            return;
          }
          const body = await res.json().catch(() => ({}));
          say(signinMsg, body.error ?? 'That passkey was not recognised.', 'error');
        } catch (err) {
          if (err?.name !== 'NotAllowedError') {
            say(signinMsg, `Could not sign in with a passkey: ${err?.message ?? err}`, 'error');
          }
        } finally {
          signin.disabled = false;
        }
      });
    }
  }

  const add = document.getElementById('add-passkey');
  const addMsg = document.getElementById('add-passkey-msg');
  if (add) {
    if (!window.PublicKeyCredential || !startRegistration) {
      add.hidden = true;
      return;
    }
    add.addEventListener('click', async () => {
      add.disabled = true;
      say(addMsg, 'Follow your browser or password manager prompt…', 'info');
      try {
        const optRes = await postJson('/api/auth/passkey/register/options');
        if (!optRes.ok) {
          say(addMsg, 'Could not start registration. Try signing in again.', 'error');
          return;
        }
        const options = await optRes.json();
        const attResp = await startRegistration({ optionsJSON: options });

        const res = await postJson('/api/auth/passkey/register/verify', attResp);
        const body = await res.json().catch(() => ({}));

        if (res.ok && body.ok) {
          // Reload so the new key appears in the list -- and say so first, because
          // the previous version reloaded silently and looked like nothing happened.
          say(addMsg, 'Passkey added.', 'ok');
          setTimeout(() => location.reload(), 600);
          return;
        }
        // The real failure this replaces: the server rejected the credential and the
        // page did nothing at all, while the password manager had already saved it.
        say(addMsg, body.error ?? 'The server rejected that passkey. Nothing was saved.', 'error');
      } catch (err) {
        if (err?.name === 'NotAllowedError') say(addMsg, 'Cancelled.', 'info');
        else if (err?.name === 'InvalidStateError')
          say(addMsg, 'That device already has a passkey for this account.', 'info');
        else say(addMsg, `Could not add a passkey: ${err?.message ?? err}`, 'error');
      } finally {
        add.disabled = false;
      }
    });
  }
}

localiseTimes();
reportTimezone();
initPush();
initPasskeys();
