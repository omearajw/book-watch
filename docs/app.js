import { config } from './config.js';

const { owner, repo, branch } = config;
const API = `https://api.github.com/repos/${owner}/${repo}`;
const SITE_NAMES = { vinted: 'Vinted', abebooks: 'AbeBooks', wob: 'World of Books', amazon: 'Amazon' };
const TOKEN_KEY = 'bookwatch.token';
const SHOWN = 15;

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const gbp = n => (n == null ? '£?' : `£${Number(n).toFixed(2).replace(/\.00$/, '')}`);
const list = s => String(s ?? '').split(',').map(t => t.trim()).filter(Boolean);

// localStorage can throw in private mode; the page still works read-only without it.
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};

let token = store.get(TOKEN_KEY);
let watches = [];
let matches = { watches: {} };
const ui = { tab: {}, expanded: {}, draftPrice: {} };

const fromB64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));
const toB64 = s => {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const authHeaders = () => (token ? { Authorization: `Bearer ${token}` } : {});

async function readJson(path) {
  if (token) {
    const r = await fetch(`${API}/contents/${path}?ref=${branch}`, { headers: { ...authHeaders(), Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      return { data: JSON.parse(fromB64(j.content)), sha: j.sha };
    }
  }
  const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Couldn't load ${path}`);
  return { data: await r.json(), sha: null };
}

// Read-modify-write against the repo. A 409 means someone else (usually the checker)
// committed in between, so re-read and try again.
async function updateJson(path, mutate, message) {
  if (!token) throw new Error('Add the editing key in Settings first.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${API}/contents/${path}?ref=${branch}`, { headers: { ...authHeaders(), Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 401 ? 'The editing key was refused. Check it in Settings.' : `GitHub said ${r.status}`);
    const j = await r.json();
    const next = mutate(JSON.parse(fromB64(j.content)));
    const put = await fetch(`${API}/contents/${path}`, {
      method: 'PUT',
      headers: { ...authHeaders(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: toB64(JSON.stringify(next, null, 2) + '\n'), sha: j.sha, branch }),
    });
    if (put.ok) return next;
    if (put.status !== 409 && put.status !== 422) {
      const err = await put.json().catch(() => ({}));
      throw new Error(put.status === 403 || put.status === 404 ? "The editing key can't change this repo." : err.message || `GitHub said ${put.status}`);
    }
  }
  throw new Error('Someone else saved at the same moment. Try again.');
}

let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function ago(date) {
  const mins = Math.round((Date.now() - date) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

async function loadStatus() {
  const el = $('#status');
  try {
    const r = await fetch(`${API}/actions/workflows/check.yml/runs?per_page=1&status=completed`, { headers: authHeaders(), cache: 'no-store' });
    const run = (await r.json()).workflow_runs?.[0];
    if (!run) { el.textContent = 'Not checked yet'; return; }
    const when = new Date(run.updated_at);
    // Schedules run every 15 minutes but GitHub often starts them late; two hours of
    // silence means the schedule has stopped, which she should know about.
    const stale = Date.now() - when > 2 * 3600 * 1000 || run.conclusion !== 'success';
    el.className = `status${stale ? ' stale' : ''}`;
    el.innerHTML = `<span class="dot"></span>${run.conclusion === 'success' ? 'Checked' : 'Last check failed'} ${esc(ago(when))}`;
  } catch {
    el.textContent = '';
  }
}

function listingRow(l) {
  const badges = [];
  if (l.strength === 'strong') badges.push(`<span class="badge strong">Mentions “${esc(l.matchedTerm)}”</span>`);
  if (l.strength === 'possible') badges.push(`<span class="badge possible">Maybe: “${esc(l.matchedTerm)}”</span>`);
  if (l.reserved) badges.push('<span class="badge reserved">Reserved</span>');
  const meta = [l.site, l.condition, l.sellerStars != null ? `seller ${l.sellerStars}★ (${l.sellerReviews})` : null].filter(Boolean).map(esc).join(' · ');
  const postage = l.postage === 'not included' ? '+ postage' : l.postage === 'free UK delivery' || /free/i.test(l.postage ?? '') ? 'free postage' : l.total !== l.price ? 'incl. postage' : '';
  return `<li class="listing"><a href="${esc(l.url)}" target="_blank" rel="noopener">
    <div class="price">${esc(gbp(l.total))}${postage ? `<small>${esc(postage)}</small>` : ''}</div>
    <div class="body">${badges.join('')}<p class="name">${esc(l.title)}</p><p class="meta">${meta}</p></div>
  </a></li>`;
}

function watchCard(w) {
  const m = matches.watches[w.id] ?? { sites: {}, listings: [] };
  const all = m.listings ?? [];
  const alerts = all.filter(l => l.alertable);
  const tab = ui.tab[w.id] ?? 'alerts';
  const shown = tab === 'alerts' ? alerts : all;
  const limit = ui.expanded[w.id] ? shown.length : SHOWN;
  const price = ui.draftPrice[w.id] ?? w.maxPrice;
  const dirty = price !== w.maxPrice;

  const siteChips = (w.sites ?? []).map(k => {
    const s = m.sites?.[k];
    const label = s === 'blocked' ? `${SITE_NAMES[k]}: blocked this time` : s === 'error' ? `${SITE_NAMES[k]}: error` : SITE_NAMES[k];
    return `<span class="site ${esc(s ?? '')}">${esc(label)}</span>`;
  }).join('');

  const emptyText = tab === 'alerts'
    ? (all.length ? `Nothing matching under ${gbp(w.maxPrice)} right now. You'll get a notification when something appears.` : 'No results yet. The first check runs within 15 minutes of adding a watch.')
    : 'No listings found yet.';

  return `<article class="watch" data-id="${esc(w.id)}">
    <div class="watch-head">
      <div class="watch-title">
        <h2>${esc(w.name)}${w.paused ? '<span class="paused-tag">Paused</span>' : ''}</h2>
        <button class="link-btn" data-edit>Edit</button>
      </div>
      <div class="price-row">
        <span class="label">Tell me under</span>
        <span class="stepper">
          <button data-step="-1" aria-label="£1 less">−</button>
          <span class="amount" aria-live="polite">${esc(gbp(price))}</span>
          <button data-step="1" aria-label="£1 more">+</button>
        </span>
        ${dirty ? '<button class="btn primary" data-save-price>Save</button>' : ''}
      </div>
      <div class="sites">${siteChips}</div>
    </div>
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="alerts" aria-selected="${tab === 'alerts'}">Under ${esc(gbp(w.maxPrice))} (${alerts.length})</button>
      <button role="tab" data-tab="all" aria-selected="${tab === 'all'}">All listings (${all.length})</button>
    </div>
    ${shown.length ? `<ul class="listings">${shown.slice(0, limit).map(listingRow).join('')}</ul>` : `<p class="empty">${esc(emptyText)}</p>`}
    ${shown.length > limit ? `<button class="more" data-more>Show ${shown.length - limit} more</button>` : ''}
  </article>`;
}

function render() {
  $('#watches').innerHTML = watches.length
    ? watches.map(watchCard).join('')
    : '<div class="notice"><p>No watches yet.</p></div>';
  $('#add-watch').hidden = !token;
  renderNotices();
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function renderNotices() {
  const out = [];
  if (isIOS() && !standalone()) {
    out.push(`<div class="notice"><p><b>For notifications, add this to your Home Screen.</b> iPhones only allow website notifications from a Home Screen app.</p>
      <ol><li>Tap the Share button <span aria-hidden="true">(the square with an arrow)</span></li><li>Choose <b>Add to Home Screen</b></li><li>Open Book Watch from your Home Screen and turn on notifications in Settings</li></ol></div>`);
  } else if (!token) {
    out.push('<div class="notice"><p>To change a watch or turn on notifications, add the editing key in <a href="#settings" data-open-settings>Settings</a>.</p></div>');
  } else if (pushSupported() && Notification.permission !== 'granted') {
    out.push('<div class="notice"><p>Notifications are off on this phone. <a href="#settings" data-open-settings>Turn them on</a>.</p></div>');
  }
  $('#notices').innerHTML = out.join('');
}

async function renderNotifyPanel() {
  const el = $('#notify-panel');
  if (isIOS() && !standalone()) {
    el.innerHTML = '<p class="hint">Add Book Watch to your Home Screen first (Share, then Add to Home Screen), then open it from there.</p>';
    return;
  }
  if (!pushSupported()) {
    el.innerHTML = "<p class=\"hint\">This browser can't receive notifications from websites.</p>";
    return;
  }
  if (Notification.permission === 'denied') {
    el.innerHTML = '<p class="hint">Notifications are blocked. Turn them on in the iPhone Settings app under Notifications, Book Watch.</p>';
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (Notification.permission === 'granted' && sub) {
    el.innerHTML = `<p>On for this phone.</p><div class="row-actions"><button class="btn" id="test-push">Send a test</button></div>`;
    $('#test-push').onclick = () => saveSubscription(sub, 'Test requested. It should arrive within a couple of minutes.');
  } else {
    el.innerHTML = `<p class="hint">Get a notification on this phone when a listing matches.</p><div class="row-actions"><button class="btn primary" id="enable-push">Turn on notifications</button></div>`;
    $('#enable-push').onclick = enablePush;
  }
}

function keyBytes(b64url) {
  const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function enablePush() {
  if (!token) { toast('Add the editing key below first.'); return; }
  // iOS only shows the permission prompt from a direct tap, so ask before any other await.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { renderNotifyPanel(); renderNotices(); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.vapidPublicKey) });
    await saveSubscription(sub, "Notifications are on. A welcome message should arrive within a couple of minutes.");
  } catch (e) {
    toast(`Couldn't turn on notifications: ${e.message}`, 6000);
  }
}

async function saveSubscription(sub, doneMessage) {
  const json = sub.toJSON();
  const label = isIOS() ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Browser';
  try {
    await updateJson('data/push-subscriptions.json', d => {
      const existing = (d.subscriptions ?? []).find(s => s.endpoint === json.endpoint);
      const others = (d.subscriptions ?? []).filter(s => s.endpoint !== json.endpoint);
      return { subscriptions: [...others, { endpoint: json.endpoint, keys: json.keys, label, addedAt: existing?.addedAt ?? new Date().toISOString(), testAt: new Date().toISOString() }] };
    }, `Notifications: ${label}`);
    toast(doneMessage, 6000);
  } catch (e) {
    toast(e.message, 6000);
  }
  renderNotifyPanel();
  renderNotices();
}

async function saveWatches(mutate, message, doneMessage) {
  try {
    const next = await updateJson('data/watches.json', d => ({ watches: mutate(d.watches ?? []) }), message);
    watches = next.watches;
    render();
    toast(doneMessage);
    return true;
  } catch (e) {
    toast(e.message, 6000);
    return false;
  }
}

function openEditor(watch) {
  const form = $('#editor-form');
  const isNew = !watch;
  const w = watch ?? { name: '', query: '', maxPrice: 20, alertOn: 'any', mustInclude: [], strong: [], possible: [], exclude: [], sites: Object.keys(SITE_NAMES), paused: false };
  $('#editor-title').textContent = isNew ? 'New watch' : 'Edit watch';
  form.watchName.value = w.name;
  form.query.value = w.query;
  form.maxPrice.value = w.maxPrice;
  form.alertOn.value = w.alertOn ?? 'possible';
  form.mustInclude.value = (w.mustInclude ?? []).join(', ');
  form.strong.value = (w.strong ?? []).join(', ');
  form.possible.value = (w.possible ?? []).join(', ');
  form.exclude.value = (w.exclude ?? []).join(', ');
  form.paused.checked = Boolean(w.paused);
  $('#site-checks').innerHTML = Object.entries(SITE_NAMES).map(([k, name]) =>
    `<label><input type="checkbox" name="site" value="${k}" ${(w.sites ?? []).includes(k) ? 'checked' : ''}> ${esc(name)}</label>`).join('');
  $('#delete-watch').hidden = isNew;
  form.dataset.id = watch?.id ?? '';
  $('#editor').showModal();
}

function readEditor() {
  const f = $('#editor-form');
  const query = f.query.value.trim();
  return {
    name: f.watchName.value.trim(),
    query,
    maxPrice: Number(f.maxPrice.value),
    alertOn: f.alertOn.value,
    mustInclude: list(f.mustInclude.value).length ? list(f.mustInclude.value) : [query],
    strong: list(f.strong.value),
    possible: list(f.possible.value),
    exclude: list(f.exclude.value),
    sites: [...f.querySelectorAll('input[name=site]:checked')].map(i => i.value),
    paused: f.paused.checked,
  };
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'watch';

function wireEvents() {
  $('#watches').addEventListener('click', async e => {
    const card = e.target.closest('.watch');
    if (!card) return;
    const id = card.dataset.id;
    const w = watches.find(x => x.id === id);
    const t = e.target.closest('button');
    if (!t || !w) return;

    if (t.dataset.tab) { ui.tab[id] = t.dataset.tab; ui.expanded[id] = false; render(); }
    else if ('more' in t.dataset) { ui.expanded[id] = true; render(); }
    else if ('edit' in t.dataset) {
      if (!token) { toast('Add the editing key in Settings first.'); return; }
      openEditor(w);
    } else if (t.dataset.step) {
      const next = Math.max(1, (ui.draftPrice[id] ?? w.maxPrice) + Number(t.dataset.step));
      ui.draftPrice[id] = next === w.maxPrice ? undefined : next;
      render();
    } else if ('savePrice' in t.dataset) {
      if (!token) { toast('Add the editing key in Settings first.'); return; }
      const price = ui.draftPrice[id];
      t.disabled = true;
      const ok = await saveWatches(ws => ws.map(x => (x.id === id ? { ...x, maxPrice: price } : x)), `Set ${w.name} to ${gbp(price)}`, `Saved. You'll hear about listings under ${gbp(price)}.`);
      if (ok) ui.draftPrice[id] = undefined;
      render();
    }
  });

  document.addEventListener('click', e => {
    if (e.target.closest('[data-open-settings]')) {
      e.preventDefault();
      $('#settings').open = true;
      $('#settings').scrollIntoView({ behavior: 'smooth' });
    }
  });

  $('#add-watch').onclick = () => openEditor(null);
  $('#editor').addEventListener('click', e => {
    if (e.target.closest('[data-close]') || e.target === $('#editor')) $('#editor').close();
  });

  $('#editor-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = e.target.dataset.id;
    const fields = readEditor();
    if (!fields.sites.length) { toast('Pick at least one site.'); return; }
    $('#save-watch').disabled = true;
    const ok = id
      ? await saveWatches(ws => ws.map(x => (x.id === id ? { ...x, ...fields } : x)), `Edit watch: ${fields.name}`, 'Saved. Checking again now; new results in a couple of minutes.')
      : await saveWatches(ws => [...ws, { id: `${slug(fields.name)}-${Math.random().toString(36).slice(2, 6)}`, ...fields }], `Add watch: ${fields.name}`, 'Added. The first results arrive in a couple of minutes.');
    $('#save-watch').disabled = false;
    if (ok) $('#editor').close();
  });

  $('#delete-watch').onclick = async () => {
    const id = $('#editor-form').dataset.id;
    const w = watches.find(x => x.id === id);
    if (!w || !confirm(`Stop watching “${w.name}”?`)) return;
    const ok = await saveWatches(ws => ws.filter(x => x.id !== id), `Delete watch: ${w.name}`, 'Watch deleted.');
    if (ok) $('#editor').close();
  };

  $('#save-token').onclick = async () => {
    const value = $('#token').value.trim();
    const status = $('#token-status');
    if (!value) { token = null; store.set(TOKEN_KEY, null); status.textContent = 'Key removed from this phone.'; render(); return; }
    status.textContent = 'Checking…';
    const r = await fetch(API, { headers: { Authorization: `Bearer ${value}` } });
    if (!r.ok) { status.textContent = "That key didn't work. Check it was copied in full."; return; }
    token = value;
    store.set(TOKEN_KEY, value);
    $('#token').value = '';
    status.textContent = 'Key saved on this phone.';
    render();
    renderNotifyPanel();
  };

  $('#refresh').onclick = () => load(true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
}

let loading = false;
async function load(manual = false) {
  if (loading) return;
  loading = true;
  $('#refresh').classList.add('spinning');
  try {
    const [w, m] = await Promise.all([readJson('data/watches.json'), readJson('data/matches.json')]);
    watches = w.data.watches ?? [];
    matches = m.data ?? { watches: {} };
    render();
    loadStatus();
    if (manual) toast('Up to date.');
  } catch (e) {
    $('#watches').innerHTML = `<div class="notice warn"><p>${esc(e.message)}. Check your connection and tap refresh.</p></div>`;
  } finally {
    loading = false;
    $('#refresh').classList.remove('spinning');
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(() => renderNotifyPanel()).catch(() => {});
$('#token-status').textContent = token ? 'A key is saved on this phone.' : '';
wireEvents();
load();
renderNotifyPanel();
