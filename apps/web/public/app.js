/* Progressive enhancement only. Every control on this site already works as a plain
   form; this file adds push notifications and passkeys where the browser has them. */

const urlB64ToUint8Array = (b64) => {
  const padded = (b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

const postJson = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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

  // Only offer the button where it can actually work. Showing an opt-in that does
  // nothing on iOS Safari outside standalone mode is worse than hiding it.
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

async function initPasskeys() {
  const { startAuthentication, startRegistration } = window.SimpleWebAuthnBrowser ?? {};

  const signin = document.getElementById('passkey-signin');
  if (signin) {
    if (!window.PublicKeyCredential || !startAuthentication) signin.hidden = true;
    else
      signin.addEventListener('click', async () => {
        const options = await (await postJson('/api/auth/passkey/authenticate/options')).json();
        const asseResp = await startAuthentication({ optionsJSON: options });
        const res = await postJson('/api/auth/passkey/authenticate/verify', asseResp);
        if (res.ok) location.href = '/following';
      });
  }

  const add = document.getElementById('add-passkey');
  if (add) {
    if (!window.PublicKeyCredential || !startRegistration) add.hidden = true;
    else
      add.addEventListener('click', async () => {
        const options = await (await postJson('/api/auth/passkey/register/options')).json();
        const attResp = await startRegistration({ optionsJSON: options });
        const res = await postJson('/api/auth/passkey/register/verify', attResp);
        if (res.ok) location.reload();
      });
  }
}

initPush();
initPasskeys();
