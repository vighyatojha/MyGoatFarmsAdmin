// My Goat Farms — admin panel (single page).
// One HTML file, one set of live Firestore listeners. Switching sections only
// swaps which <section class="view"> is visible, so nothing reloads and the
// data is already there when a section opens.

import { auth } from './firebase-config.js?v=20261007c';
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import {
  watchFarms, watchEnquiries, loadFarmStats, getFarmDetail, isAdminUid,
  approveFarm, renewFarm, rejectFarm, blockFarm, unblockFarm,
  markEnquiriesRead, markEnquiriesNew, deleteEnquiries,
  getPlans, savePlans, getAdminContact, saveAdminContact, DEFAULT_PLANS, localKeyOf,
} from './db.js?v=20261007c';
import { bindForm, schemas, check, setFieldError, localDateKey, LIMITS } from './validators.js?v=20261007c';

/* =====================================================================
   Small helpers
   ===================================================================== */

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const DAY_MS = 86400000;
const HINT_KEY = 'mgf.admin.email';
const EXPIRING_DAYS = 15;

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

function fmtDate(v) {
  if (!v) return '—';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const num = (n) => (Number(n) || 0).toLocaleString('en-IN');
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

function relDay(ms) {
  if (!ms) return '';
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(ms)) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return `${days} days ago`;
  return fmtDate(ms);
}
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

function initials(name) {
  return (String(name || '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();
}

const statusPill = (s) => `<span class="status s-${esc(String(s).toLowerCase())}">${esc(s)}</span>`;

// The subscription "runway": how much of the paid period is left.
function runway(f) {
  if (!f.expiryDate) {
    return f.status === 'Rejected' ? '<span class="runway-none">Rejected</span>' : '<span class="runway-none">Not started</span>';
  }
  const total = f.subscription?.durationDays || 365;
  const left = f.daysLeft;
  const pct = Math.max(0, Math.min(100, (left / total) * 100));
  const tone = f.status === 'Blocked' ? 'paused' : left <= 0 ? 'over' : left <= EXPIRING_DAYS ? 'warn' : left <= 30 ? 'soon' : 'ok';
  let label;
  if (left <= 0) label = left === 0 ? 'Expired today' : `Expired ${plural(-left, 'day')} ago`;
  else if (left === 1) label = 'Expires tomorrow';
  else label = `${plural(left, 'day')} left`;
  return `<div class="runway ${tone}"><span class="runway-track" aria-hidden="true"><span class="runway-fill" style="width:${pct.toFixed(1)}%"></span></span><span class="runway-label">${label}</span></div>`;
}

/* ---------------- CSV (UTF-8 BOM so ₹ and Gujarati names open in Excel) ---------------- */

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(filename, header, rows) {
  const text = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------------- Toast, banner, confirm ---------------- */

function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), Math.min(9000, Math.max(3200, String(msg).length * 60)));
}

function banner(msg, tone = 'info') {
  const b = $('banner');
  b.hidden = !msg;
  b.textContent = msg || '';
  b.dataset.tone = tone;
}

function confirmAction({ title, text, ok = 'Confirm', danger = true }) {
  const dlg = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmOk').textContent = ok;
  $('confirmOk').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

// Wire every [data-close] button and backdrop click on all dialogs once.
$$('dialog').forEach((dlg) => {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === dlg) dlg.close();
  });
});

function friendlyError(err) {
  if (err?.fields) return err.message;
  switch (err?.code) {
    case 'permission-denied': return "Firestore refused this change. Check that your account is still an admin and the latest firestore.rules are published.";
    case 'unavailable': return "Couldn't reach Firebase. Check your connection and try again.";
    case 'not-found': return err.message;
    default: return err?.message || 'Something went wrong. Try again.';
  }
}

async function busy(btn, label, fn) {
  if (btn.disabled) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = original; }
}

/* =====================================================================
   Store — one copy of the data, shared by every section
   ===================================================================== */

const store = {
  user: null,
  farms: [], enquiries: [],
  loaded: { farms: false, enquiries: false },
  details: new Map(),
  stats: new Map(),
  statsLoading: new Set(),
  plans: DEFAULT_PLANS.map((p) => ({ ...p })),
  contact: null,
};
let unsubscribers = [];
let started = false;

function startData() {
  if (started) return;
  started = true;
  const fail = (what) => (err) => { console.error(what, err); banner(`${what} couldn't load: ${friendlyError(err)}`, 'error'); };

  unsubscribers.push(watchFarms((list) => {
    store.farms = list;
    store.loaded.farms = true;
    loadMissingStats();
    scheduleRender();
  }, fail('Farms')));
  unsubscribers.push(watchEnquiries((list) => { store.enquiries = list; store.loaded.enquiries = true; scheduleRender(); }, fail('Enquiries')));

  getPlans().then((p) => { store.plans = p; if (current === 'settings') settingsView.load(); }).catch(() => {});
}

function stopData() {
  unsubscribers.forEach((u) => { try { u(); } catch { /* already gone */ } });
  unsubscribers = [];
  started = false;
  Object.assign(store, { farms: [], enquiries: [], loaded: { farms: false, enquiries: false }, contact: null });
  store.details.clear();
  store.stats.clear();
  store.statsLoading.clear();
}

// Partner / goat counts cost several reads per farm, so they are fetched
// once per farm and then only for farms that appear later — not on every
// change to any farm document. "Refresh counts" re-reads them on demand.
function loadMissingStats(force = false) {
  const ids = store.farms.map((f) => f.id).filter((id) => (force || !store.stats.has(id)) && !store.statsLoading.has(id));
  if (!ids.length) return Promise.resolve();
  ids.forEach((id) => store.statsLoading.add(id));
  scheduleRender();
  return loadFarmStats(ids, (id, s) => { store.stats.set(id, s); store.statsLoading.delete(id); scheduleRender(); });
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    VIEWS[current]?.render();
    renderCounts();
  });
}

const derived = {
  pending: () => store.farms.filter((f) => f.status === 'Pending'),
  expiring: () => store.farms.filter((f) => f.status === 'Active' && f.daysLeft != null && f.daysLeft <= EXPIRING_DAYS),
  expired: () => store.farms.filter((f) => f.status === 'Expired'),
  newEnquiries: () => store.enquiries.filter((e) => e.status === 'New'),
};

function renderCounts() {
  const counts = { pending: derived.pending().length, expiring: derived.expiring().length, newEnquiries: derived.newEnquiries().length };
  $$('.chips').forEach((c) => c.classList.toggle('loading', c.id === 'enqChips' ? !store.loaded.enquiries : !store.loaded.farms));
  $$('[data-count]').forEach((el) => {
    const n = counts[el.dataset.count] || 0;
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : n;
  });
}

const skeletonRows = (n, cls = 'skeleton-row') => Array.from({ length: n }, () => `<div class="${cls}"></div>`).join('');
const kpi = (label, value, note = '', tone = '') => `<div class="kpi ${tone}"><span class="kpi-label">${esc(label)}</span><span class="kpi-value">${value}</span>${note ? `<span class="kpi-note">${note}</span>` : ''}</div>`;

/* =====================================================================
   Router
   ===================================================================== */

const META = {
  dashboard: ['Dashboard', 'What needs your attention today.'],
  farms: ['Farms', 'Every farm that has signed up in the app.'],
  subscriptions: ['Subscriptions', "Each countdown starts on the farm's approval date."],
  farm: ['Farm', ''],
  enquiries: ['Enquiries', 'Messages sent through the Contact form.'],
  reports: ['Reports', 'Download farm, subscription and enquiry data as CSV.'],
  settings: ['Settings', 'Plans, the support contact farmers see, and your account.'],
};
let current = null;

let routeParam = '';
function routeFromHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').map((x) => decodeURIComponent(x));
  routeParam = '';
  if (parts[0] === 'farms' && parts[1]) { routeParam = parts[1]; return 'farm'; }
  return META[parts[0]] && parts[0] !== 'farm' ? parts[0] : 'dashboard';
}

let currentParam = '';
function showView(key, { focus = true } = {}) {
  const changed = key !== current || routeParam !== currentParam;
  current = key;
  currentParam = routeParam;
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== key; });
  const navKey = key === 'farm' ? 'farms' : key;
  $$('.nav-link[data-view]').forEach((a) => {
    const on = a.dataset.view === navKey;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const [title, subtitle] = VIEWS[key].meta ? VIEWS[key].meta() : META[key];
  setTitle(title, subtitle);
  $('topbarActions').innerHTML = VIEWS[key].actions ? VIEWS[key].actions() : '';
  VIEWS[key].enter?.();
  VIEWS[key].render();
  renderCounts();
  setSidebar(false);
  if (changed && focus) { window.scrollTo({ top: 0 }); $('viewTitle').focus({ preventScroll: true }); }
}

function setTitle(title, subtitle) {
  $('viewTitle').textContent = title;
  $('viewSubtitle').textContent = subtitle;
  document.title = `${title} · My Goat Farms Admin`;
}

window.addEventListener('hashchange', () => { if (document.body.dataset.screen === 'app') showView(routeFromHash()); });

/* ---------------- Mobile sidebar drawer ---------------- */

function setSidebar(open) {
  document.body.classList.toggle('nav-open', open);
  $('menuBtn').setAttribute('aria-expanded', String(open));
  $('scrim').hidden = !open;
}
$('menuBtn').addEventListener('click', () => setSidebar(!document.body.classList.contains('nav-open')));
$('sidebarClose').addEventListener('click', () => setSidebar(false));
$('scrim').addEventListener('click', () => setSidebar(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSidebar(false); });

/* =====================================================================
   Farm actions (shared by Dashboard, Farms, Subscriptions)
   ===================================================================== */

const subDialog = {
  farm: null,
  mode: 'approve',
  validator: bindForm(
    { plan: $('subPlan'), durationDays: $('subDuration') },
    schemas.subscription
  ),

  open(farm, mode) {
    this.farm = farm;
    this.mode = mode;
    this.validator.reset();
    const approve = mode === 'approve';
    $('subTitle').textContent = approve ? `Approve ${farm.farmName || farm.id}` : `Renew ${farm.farmName || farm.id}`;
    $('subNote').textContent = approve
      ? 'The subscription starts today, the day you approve it.'
      : farm.daysLeft > 0 ? `Adds to the current expiry date, ${fmtDate(farm.expiryDate)}.` : 'The subscription has run out, so the new period starts today.';
    $('subSave').textContent = approve ? 'Approve farm' : 'Renew subscription';

    const plans = store.plans.length ? store.plans : DEFAULT_PLANS;
    $('subPlan').innerHTML = plans.map((p) => `<option value="${esc(p.name)}" data-days="${Number(p.days)}">${esc(p.name)} (${plural(Number(p.days), 'day')})</option>`).join('');
    // Start from the farm's current plan if it still exists, else the first
    // plan, and always take the duration from that same plan.
    const chosen = plans.find((p) => p.name === farm.subscription?.plan) || plans[0];
    $('subPlan').value = chosen.name;
    $('subDuration').value = chosen.days;
    this.preview();
    $('subDialog').showModal();
  },

  preview() {
    const days = Number($('subDuration').value);
    if (!Number.isInteger(days) || days < 1 || !this.farm) { $('subPreview').textContent = ''; return; }
    const base = this.mode === 'renew' && this.farm.expiryDate > Date.now() ? this.farm.expiryDate : Date.now();
    $('subPreview').innerHTML = `New expiry date: <strong>${fmtDate(base + days * DAY_MS)}</strong>`;
  },
};

$('subPlan').addEventListener('change', (e) => {
  const opt = e.target.selectedOptions[0];
  if (!opt) return;
  $('subDuration').value = opt.dataset.days;
  subDialog.preview();
});
$('subDuration').addEventListener('input', () => subDialog.preview());

$('subForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!subDialog.validator.validate()) return;
  const { farm, mode } = subDialog;
  await busy($('subSave'), 'Saving…', async () => {
    try {
      const body = subDialog.validator.values();
      if (mode === 'approve') await approveFarm(farm.id, body, store.user?.email);
      else await renewFarm(farm.id, body, store.user?.email);
      $('subDialog').close();
      toast(mode === 'approve' ? `${farm.farmName || farm.id} approved.` : `${farm.farmName || farm.id} renewed.`);
    } catch (err) {
      if (err.fields) subDialog.validator.showErrors(err.fields);
      toast(friendlyError(err), true);
    }
  });
});

const reasonDialog = {
  farm: null,
  action: 'block',
  validator: bindForm({ reason: $('reasonText') }, schemas.reason),
  open(farm, action) {
    this.farm = farm;
    this.action = action;
    this.validator.reset();
    const reject = action === 'reject';
    $('reasonTitle').textContent = `${reject ? 'Reject' : 'Block'} ${farm.farmName || farm.id}`;
    $('reasonNote').textContent = reject
      ? 'The farm stays in the app with a rejected message. You can approve it later.'
      : 'The farmer loses access in the app until you unblock the farm.';
    $('reasonSave').textContent = reject ? 'Reject farm' : 'Block farm';
    $('reasonText').value = '';
    $('reasonCount').textContent = `0 / ${LIMITS.reason}`;
    $('reasonDialog').showModal();
  },
};
$('reasonText').addEventListener('input', () => { $('reasonCount').textContent = `${$('reasonText').value.length} / ${LIMITS.reason}`; });
$('reasonForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!reasonDialog.validator.validate()) return;
  const { farm, action } = reasonDialog;
  await busy($('reasonSave'), 'Saving…', async () => {
    try {
      const reason = $('reasonText').value;
      if (action === 'reject') await rejectFarm(farm.id, reason, store.user?.email);
      else await blockFarm(farm.id, reason, store.user?.email);
      $('reasonDialog').close();
      toast(`${farm.farmName || farm.id} ${action === 'reject' ? 'rejected' : 'blocked'}.`);
    } catch (err) {
      if (err.fields) reasonDialog.validator.showErrors(err.fields);
      toast(friendlyError(err), true);
    }
  });
});

function farmActions(f, { compact = false } = {}) {
  const b = (action, label, cls = 'btn-quiet') => `<button class="btn ${cls} btn-sm" type="button" data-farm-action="${action}" data-id="${esc(f.id)}">${label}</button>`;
  const out = [];
  if (f.status === 'Pending') out.push(b('approve', 'Approve', 'btn-primary'), b('reject', 'Reject'));
  else if (f.status === 'Rejected') out.push(b('approve', 'Approve'));
  else if (f.status === 'Active' || f.status === 'Expired') out.push(b('renew', 'Renew', f.status === 'Expired' || f.daysLeft <= EXPIRING_DAYS ? 'btn-primary' : 'btn-quiet'), compact ? '' : b('block', 'Block'));
  else if (f.status === 'Blocked') out.push(b('unblock', 'Unblock'));
  return out.join('');
}

async function runFarmAction(action, id, btn) {
  const farm = store.farms.find((f) => f.id === id);
  if (!farm) return;
  if (action === 'view') { location.hash = `#/farms/${encodeURIComponent(farm.id)}`; return; }
  if (action === 'approve' || action === 'renew') return subDialog.open(farm, action);
  if (action === 'reject' || action === 'block') return reasonDialog.open(farm, action);
  if (action === 'unblock') {
    const ok = await confirmAction({ title: `Unblock ${farm.farmName || farm.id}?`, text: 'The farmer gets access back in the app straight away.', ok: 'Unblock farm', danger: false });
    if (!ok) return;
    const run = async () => {
      try { await unblockFarm(farm.id, store.user?.email); toast(`${farm.farmName || farm.id} unblocked.`); }
      catch (err) { toast(friendlyError(err), true); }
    };
    return btn ? busy(btn, 'Unblocking…', run) : run();
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-farm-action]');
  if (!btn) return;
  e.preventDefault();
  runFarmAction(btn.dataset.farmAction, btn.dataset.id, btn);
});

/* =====================================================================
   Views
   ===================================================================== */

const VIEWS = {};

/* ---------------- Dashboard ---------------- */

VIEWS.dashboard = {
  render() {
    const { farms, loaded } = store;
    const ready = loaded.farms;
    const pending = derived.pending();
    const expiring = derived.expiring();
    const expired = derived.expired();
    const newEnq = derived.newEnquiries();

    $('dashKpis').innerHTML = ready
      ? kpi('Waiting for approval', pending.length, pending.length ? 'Review below' : 'All caught up', pending.length ? 'tone-warn' : '')
        + kpi('Active farms', farms.filter((f) => f.status === 'Active').length, `of ${plural(farms.length, 'farm')}`)
        + kpi(`Expiring in ${EXPIRING_DAYS} days`, expiring.length, expired.length ? `${expired.length} already expired` : 'None expired', expiring.length || expired.length ? 'tone-warn' : '')
        + kpi('Blocked', farms.filter((f) => f.status === 'Blocked').length, 'Access suspended')
        + kpi('Unread enquiries', loaded.enquiries ? newEnq.length : '…', loaded.enquiries ? `${num(store.enquiries.length)} in total` : '', newEnq.length ? 'tone-info' : '')
      : skeletonRows(5, 'kpi skeleton');

    // The queue: one row per thing that needs a decision, most urgent first.
    const items = [];
    const signedUp = (ms) => { const r = relDay(ms); return /^\d/.test(r) ? `on ${r}` : r.toLowerCase(); };
    pending.forEach((f) => items.push({ tone: 'warn', farm: f, title: f.farmName || f.id, line: f.createdAt ? `Signed up ${signedUp(f.createdAt)}, waiting for approval` : 'Waiting for approval', sort: 0 }));
    expired.forEach((f) => items.push({ tone: 'over', farm: f, title: f.farmName || f.id, line: `Subscription ended ${fmtDate(f.expiryDate)}`, sort: 1 }));
    expiring.sort((a, b) => a.daysLeft - b.daysLeft).forEach((f) => items.push({ tone: 'soon', farm: f, title: f.farmName || f.id, line: f.daysLeft <= 1 ? 'Expires tomorrow' : `Expires in ${plural(f.daysLeft, 'day')}, on ${fmtDate(f.expiryDate)}`, sort: 2 }));

    let html = items.slice(0, 8).map((it) => `
      <li class="queue-item ${it.tone}">
        <span class="queue-mark" aria-hidden="true"></span>
        <button class="queue-main" type="button" data-farm-action="view" data-id="${esc(it.farm.id)}"><strong>${esc(it.title)}</strong><span>${esc(it.line)}</span></button>
        <span class="queue-actions">${farmActions(it.farm, { compact: true })}</span>
      </li>`).join('');
    if (items.length > 8) html += `<li class="queue-more"><a href="#/farms">${plural(items.length - 8, 'more farm')} in Farms</a></li>`;
    if (newEnq.length) html += `<li class="queue-item info"><span class="queue-mark" aria-hidden="true"></span><a class="queue-main" href="#/enquiries"><strong>${plural(newEnq.length, 'unread enquiry', 'unread enquiries')}</strong><span>Latest from ${esc(newEnq[0].name)}</span></a></li>`;
    $('dashQueue').innerHTML = !ready ? skeletonRows(3) : html || '<li class="empty"><strong>Nothing needs you right now.</strong><span>New sign-ups and subscriptions ending soon will show up here.</span></li>';

    const recent = [...farms].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)).slice(0, 6);
    $('dashFarms').innerHTML = !ready ? skeletonRows(4) : recent.map((f) => `
      <li><button class="feed-row" type="button" data-farm-action="view" data-id="${esc(f.id)}">
        <span class="avatar">${esc(initials(f.farmName))}</span>
        <span class="feed-main"><strong>${esc(f.farmName || f.id)}</strong><span>${esc(f.ownerName || 'No owner name')}</span></span>
        ${statusPill(f.status)}
        <time>${f.lastActivity ? relDay(f.lastActivity) : ''}</time>
      </button></li>`).join('') || '<li class="empty"><strong>No farms yet.</strong><span>Farms appear here when someone signs up in the app.</span></li>';

    $('dashEnquiries').innerHTML = !store.loaded.enquiries ? skeletonRows(3) : store.enquiries.slice(0, 5).map((q) => `
      <li><a class="feed-row" href="#/enquiries" data-open-enquiry="${esc(q.id)}">
        <span class="avatar ${q.status === 'New' ? 'new' : ''}">${esc(initials(q.name))}</span>
        <span class="feed-main"><strong>${esc(q.subject || '(no subject)')}</strong><span>${esc(q.name)}</span></span>
        <time>${relDay(q.receivedAt)}</time>
      </a></li>`).join('') || '<li class="empty"><strong>No enquiries yet.</strong><span>Messages from the website Contact form land here.</span></li>';
  },
};

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-open-enquiry]');
  if (a) enquiriesView.selectedId = a.dataset.openEnquiry;
});

/* ---------------- Farms ---------------- */

const farmsView = {
  filter: 'All',
  q: '',
  actions: () => `<button class="btn btn-quiet btn-sm" type="button" id="farmRefresh">Refresh counts</button><button class="btn btn-quiet btn-sm" type="button" id="farmExport">Export CSV</button>`,
  render() {
    const FILTERS = ['All', 'Pending', 'Active', 'Expired', 'Blocked', 'Rejected'];
    const farms = store.farms;
    $('farmChips').innerHTML = FILTERS.map((f) => {
      const n = f === 'All' ? farms.length : farms.filter((x) => x.status === f).length;
      return `<button type="button" class="chip${f === this.filter ? ' on' : ''}" data-filter="${f}" aria-pressed="${f === this.filter}">${f}<b>${n}</b></button>`;
    }).join('');

    const stats = [...store.stats.values()].filter((s) => !s.error);
    const loading = store.statsLoading.size;
    const sum = (k) => stats.reduce((n, s) => n + (s[k] || 0), 0);
    $('farmKpis').innerHTML = !store.loaded.farms ? skeletonRows(3, 'kpi skeleton') :
      kpi('Goats on farms', loading ? '…' : num(sum('totalGoats')), `${num(sum('palaiGoats'))} Palai, ${num(sum('tradingGoats'))} trading, ${num(sum('ownGoats'))} own`)
      + kpi('Active partners', loading ? '…' : num(sum('partners')), loading ? `Counting ${plural(loading, 'farm')}…` : `${num(sum('palaiCustomers'))} Palai customers`)
      + kpi('Renewing comfortably', (() => { const act = farms.filter((f) => f.status === 'Active'); return act.length ? `${Math.round((act.filter((f) => f.daysLeft > 30).length / act.length) * 100)}%` : '—'; })(), 'Active farms with 30+ days left');

    const q = this.q.trim().toLowerCase();
    const rows = farms.filter((f) => (this.filter === 'All' || f.status === this.filter)
      && (!q || [f.farmName, f.ownerName, f.mobileNumber, f.address, f.id, f.email].join(' ').toLowerCase().includes(q)));

    if (!store.loaded.farms) { $('farmList').innerHTML = skeletonRows(5, 'skeleton-card'); return; }
    $('farmList').innerHTML = rows.map((f) => {
      const s = store.stats.get(f.id);
      const n = (k) => (!s ? '<span class="dim">…</span>' : s.error ? '<span class="dim" title="Counts unavailable">—</span>' : s[k].toLocaleString('en-IN'));
      return `<article class="farm-row">
        <button class="farm-id" type="button" data-farm-action="view" data-id="${esc(f.id)}">
          <span class="avatar">${esc(initials(f.farmName))}</span>
          <span class="farm-name"><strong>${esc(f.farmName || f.id)}</strong><span>${esc(f.ownerName || '—')}${f.mobileNumber ? `, ${esc(f.mobileNumber)}` : ''}</span><span class="dim">${esc(f.id)}</span></span>
        </button>
        <div class="farm-status">${statusPill(f.status)}<span class="farm-plan">${esc(f.subscription?.plan || 'No plan yet')}</span></div>
        <div class="farm-runway">${runway(f)}</div>
        <dl class="farm-counts"><div><dt>Goats</dt><dd>${n('totalGoats')}</dd></div><div><dt>Partners</dt><dd>${n('partners')}</dd></div><div><dt>Palai customers</dt><dd>${n('palaiCustomers')}</dd></div></dl>
        <div class="farm-actions">${farmActions(f)}</div>
      </article>`;
    }).join('') || `<div class="empty-block"><strong>${farms.length ? 'No farms match.' : 'No farms yet.'}</strong><span>${farms.length ? 'Clear the search or pick another status.' : 'Farms appear here when someone signs up in the app.'}</span></div>`;
  },
};
VIEWS.farms = farmsView;

$('farmSearch').addEventListener('input', (e) => { farmsView.q = e.target.value; farmsView.render(); });
$('farmChips').addEventListener('click', (e) => { const b = e.target.closest('[data-filter]'); if (b) { farmsView.filter = b.dataset.filter; farmsView.render(); } });
$('topbarActions').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.id === 'farmRefresh') {
    await busy(btn, 'Refreshing…', async () => {
      await loadMissingStats(true);
      const failed = [...store.stats.values()].filter((s) => s.error).length;
      toast(failed ? `Counts for ${plural(failed, 'farm')} couldn't load. Check the Firestore rules.` : 'Farm counts refreshed.', !!failed);
    });
  }
  if (btn.id === 'farmExport') {
    downloadCsv(`farms-${localDateKey(new Date())}.csv`,
      ['Farm ID', 'Farm', 'Owner', 'Mobile', 'Email', 'Address', 'Status', 'Plan', 'Expiry', 'Days left', 'Partners', 'Palai customers', 'Palai goats', 'Trading goats', 'Own goats', 'Total goats'],
      store.farms.map((f) => { const s = store.stats.get(f.id) || {}; return [f.id, f.farmName, f.ownerName, f.mobileNumber, f.email, f.address, f.status, f.subscription?.plan || '', f.expiryDate ? fmtDate(f.expiryDate) : '', f.daysLeft ?? '', s.partners ?? '', s.palaiCustomers ?? '', s.palaiGoats ?? '', s.tradingGoats ?? '', s.ownGoats ?? '', s.totalGoats ?? '']; }));
    toast(`Exported ${plural(store.farms.length, 'farm')}.`);
  }
  if (btn.id === 'farmDetailRefresh') farmView.load(true);
});

/* ---------------- Subscriptions ---------------- */

const subsView = {
  filter: 'All',
  q: '',
  match(f, filter) {
    if (filter === 'All') return true;
    if (filter === 'Expiring soon') return f.status === 'Active' && f.daysLeft != null && f.daysLeft <= EXPIRING_DAYS;
    if (filter === 'Awaiting approval') return f.status === 'Pending';
    return f.status === filter;
  },
  render() {
    const FILTERS = ['All', 'Active', 'Expiring soon', 'Expired', 'Awaiting approval', 'Blocked'];
    const farms = store.farms.filter((f) => f.subscription || f.status === 'Pending');
    $('subChips').innerHTML = FILTERS.map((f) => `<button type="button" class="chip${f === this.filter ? ' on' : ''}" data-filter="${f}" aria-pressed="${f === this.filter}">${f}<b>${farms.filter((x) => this.match(x, f)).length}</b></button>`).join('');
    if (!store.loaded.farms) { $('subTable').innerHTML = `<tr><td colspan="6">${skeletonRows(4)}</td></tr>`; return; }

    const q = this.q.trim().toLowerCase();
    const rows = farms
      .filter((f) => this.match(f, this.filter) && (!q || [f.farmName, f.id, f.subscription?.plan].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => (a.daysLeft ?? -Infinity) - (b.daysLeft ?? -Infinity));
    $('subTable').innerHTML = rows.map((f) => `<tr>
      <td><button class="link-cell" type="button" data-farm-action="view" data-id="${esc(f.id)}"><strong>${esc(f.farmName || f.id)}</strong><span class="dim">${esc(f.id)}</span></button></td>
      <td data-label="Plan">${f.subscription ? esc(f.subscription.plan) : '<span class="dim">—</span>'}</td>
      <td data-label="Started">${fmtDate(f.startDate)}</td>
      <td data-label="Expires">${fmtDate(f.expiryDate)}</td>
      <td>${f.status === 'Blocked' ? statusPill('Blocked') : runway(f)}</td>
      <td class="cell-actions">${farmActions(f, { compact: true })}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty-cell">No subscriptions match. Clear the search or pick another filter.</td></tr>';
  },
};
VIEWS.subscriptions = subsView;
$('subSearch').addEventListener('input', (e) => { subsView.q = e.target.value; subsView.render(); });
$('subChips').addEventListener('click', (e) => { const b = e.target.closest('[data-filter]'); if (b) { subsView.filter = b.dataset.filter; subsView.render(); } });

/* ---------------- Enquiries ---------------- */

const enquiriesView = {
  filter: 'All',
  q: '',
  selectedId: null,
  selected: new Set(),
  visible() {
    const q = this.q.trim().toLowerCase();
    return store.enquiries.filter((e) => (this.filter === 'All' || (this.filter === 'Unread' ? e.status === 'New' : e.status === 'Read'))
      && (!q || [e.name, e.email, e.subject, e.phone].join(' ').toLowerCase().includes(q)));
  },
  clearSelection() { this.selected.clear(); },
  render() {
    const all = store.enquiries;
    const FILTERS = ['All', 'Unread', 'Read'];
    $('enqChips').innerHTML = FILTERS.map((f) => `<button type="button" class="chip${f === this.filter ? ' on' : ''}" data-filter="${f}" aria-pressed="${f === this.filter}">${f}<b>${f === 'All' ? all.length : all.filter((e) => (f === 'Unread' ? e.status === 'New' : e.status === 'Read')).length}</b></button>`).join('');
    if (!store.loaded.enquiries) { $('enqList').innerHTML = skeletonRows(5); return; }

    const rows = this.visible();
    // Only keep selections that are still visible and still exist.
    const visibleIds = new Set(rows.map((r) => r.id));
    [...this.selected].forEach((id) => { if (!visibleIds.has(id)) this.selected.delete(id); });

    $('enqList').innerHTML = rows.map((e) => `<li class="inbox-item${e.id === this.selectedId ? ' on' : ''}${e.status === 'New' ? ' unread' : ''}">
      <input type="checkbox" class="row-check" data-id="${esc(e.id)}" ${this.selected.has(e.id) ? 'checked' : ''} aria-label="Select message from ${esc(e.name)}">
      <button class="inbox-open" type="button" data-open="${esc(e.id)}">
        <span class="inbox-top"><strong>${esc(e.name)}</strong><time>${relDay(e.receivedAt)}</time></span>
        <span class="inbox-subject">${esc(e.subject || '(no subject)')}</span>
        <span class="inbox-snippet">${esc(e.message.slice(0, 90))}</span>
      </button></li>`).join('') || `<li class="empty"><strong>${all.length ? 'No messages match.' : 'No enquiries yet.'}</strong><span>${all.length ? 'Clear the search or pick another filter.' : 'Messages from the website Contact form land here.'}</span></li>`;

    const n = this.selected.size;
    $('enqBulk').hidden = !n;
    $('enqAll').checked = n > 0 && n === rows.length;
    $('enqAll').indeterminate = n > 0 && n < rows.length;
    $('enqSelLabel').textContent = n ? `${n} selected` : 'Select all';
    this.renderDetail();
  },
  renderDetail() {
    const e = store.enquiries.find((x) => x.id === this.selectedId);
    if (!e) { $('enqDetail').innerHTML = '<div class="empty-block"><strong>Pick a message to read it.</strong><span>Opening a message marks it as read.</span></div>'; return; }
    const subject = encodeURIComponent(`Re: ${e.subject}`);
    $('enqDetail').innerHTML = `
      <header class="detail-head"><h2>${esc(e.subject || '(no subject)')}</h2>${statusPill(e.status === 'New' ? 'Unread' : 'Read')}</header>
      <dl class="details compact">
        <div><dt>From</dt><dd>${esc(e.name)}</dd></div>
        <div><dt>Email</dt><dd>${esc(e.email)}</dd></div>
        <div><dt>Phone</dt><dd>${esc(e.phone || '—')}</dd></div>
        <div><dt>Received</dt><dd>${e.receivedAt ? `${fmtDate(e.receivedAt)}, ${new Date(e.receivedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : '—'}</dd></div>
      </dl>
      <div class="message">${esc(e.message)}</div>
      <div class="detail-actions">
        ${e.email ? `<a class="btn btn-primary btn-sm" href="mailto:${encodeURIComponent(e.email)}?subject=${subject}">Reply by email</a>` : ''}
        ${e.phone ? `<a class="btn btn-quiet btn-sm" href="tel:${esc(e.phone.replace(/[^\d+]/g, ''))}">Call ${esc(e.phone)}</a>` : ''}
        <button class="btn btn-quiet btn-sm" type="button" data-enq-toggle="${esc(e.id)}">${e.status === 'New' ? 'Mark read' : 'Mark unread'}</button>
      </div>`;
  },
  async open(id) {
    this.selectedId = id;
    this.render();
    const e = store.enquiries.find((x) => x.id === id);
    if (e?.status === 'New') { try { await markEnquiriesRead([id]); } catch { /* not critical */ } }
    if (window.matchMedia('(max-width: 860px)').matches) $('enqDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
};
VIEWS.enquiries = enquiriesView;

$('enqSearch').addEventListener('input', (e) => { enquiriesView.q = e.target.value; enquiriesView.clearSelection(); enquiriesView.render(); });
$('enqChips').addEventListener('click', (e) => { const b = e.target.closest('[data-filter]'); if (b) { enquiriesView.filter = b.dataset.filter; enquiriesView.clearSelection(); enquiriesView.render(); } });
$('enqList').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) enquiriesView.open(b.dataset.open); });
$('enqList').addEventListener('change', (e) => {
  const cb = e.target.closest('.row-check');
  if (!cb) return;
  if (cb.checked) enquiriesView.selected.add(cb.dataset.id); else enquiriesView.selected.delete(cb.dataset.id);
  enquiriesView.render();
});
$('enqAll').addEventListener('change', (e) => {
  enquiriesView.selected = new Set(e.target.checked ? enquiriesView.visible().map((x) => x.id) : []);
  enquiriesView.render();
});
$('enqDetail').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-enq-toggle]');
  if (!b) return;
  const q = store.enquiries.find((x) => x.id === b.dataset.enqToggle);
  if (!q) return;
  await busy(b, 'Saving…', async () => {
    try { await (q.status === 'New' ? markEnquiriesRead : markEnquiriesNew)([q.id]); }
    catch (err) { toast(friendlyError(err), true); }
  });
});
async function bulkEnquiry(fn, verb, btn) {
  const ids = [...enquiriesView.selected];
  if (!ids.length) return;
  await busy(btn, 'Working…', async () => {
    try { await fn(ids); toast(`${plural(ids.length, 'message')} ${verb}.`); enquiriesView.clearSelection(); enquiriesView.render(); }
    catch (err) { toast(friendlyError(err), true); }
  });
}
$('enqMarkRead').addEventListener('click', (e) => bulkEnquiry(markEnquiriesRead, 'marked read', e.currentTarget));
$('enqMarkNew').addEventListener('click', (e) => bulkEnquiry(markEnquiriesNew, 'marked unread', e.currentTarget));
$('enqDelete').addEventListener('click', async (e) => {
  const n = enquiriesView.selected.size;
  const btn = e.currentTarget;
  const ok = await confirmAction({ title: `Delete ${plural(n, 'message')}?`, text: "Deleted enquiries can't be recovered.", ok: `Delete ${plural(n, 'message')}` });
  if (!ok) return;
  if (enquiriesView.selected.has(enquiriesView.selectedId)) enquiriesView.selectedId = null;
  bulkEnquiry(deleteEnquiries, 'deleted', btn);
});

/* ---------------- Reports ---------------- */

const REPORTS = {
  farm: {
    title: 'Farms', desc: 'Every farm with owner details and status.',
    rows: () => store.farms, date: (f) => f.createdAt,
    cols: [['Farm ID', (f) => f.id], ['Farm', (f) => f.farmName], ['Owner', (f) => f.ownerName], ['Mobile', (f) => f.mobileNumber], ['Email', (f) => f.email], ['Address', (f) => f.address], ['Status', (f) => f.status], ['Signed up', (f) => fmtDate(f.createdAt)]],
  },
  subscription: {
    title: 'Subscriptions', desc: 'Plan, start, expiry and days left.',
    rows: () => store.farms.filter((f) => f.subscription), date: (f) => f.startDate,
    cols: [['Farm ID', (f) => f.id], ['Farm', (f) => f.farmName], ['Status', (f) => f.status], ['Plan', (f) => f.subscription?.plan], ['Started', (f) => fmtDate(f.startDate)], ['Expires', (f) => fmtDate(f.expiryDate)], ['Days left', (f) => f.daysLeft]],
  },
  enquiry: {
    title: 'Enquiries', desc: 'Every Contact form message.',
    rows: () => store.enquiries, date: (e) => e.receivedAt,
    cols: [['Name', (e) => e.name], ['Email', (e) => e.email], ['Phone', (e) => e.phone], ['Subject', (e) => e.subject], ['Message', (e) => e.message], ['Status', (e) => (e.status === 'New' ? 'Unread' : 'Read')], ['Received', (e) => fmtDate(e.receivedAt)]],
  },
};

const reportsView = {
  active: 'farm',
  render() {
    $('reportTiles').innerHTML = Object.entries(REPORTS).map(([k, r]) => {
      const n = r.rows().length;
      return `<button type="button" class="report-tile${k === this.active ? ' on' : ''}" role="radio" aria-checked="${k === this.active}" data-report="${k}"><strong>${esc(r.title)}</strong><span>${esc(r.desc)}</span><b>${plural(n, 'record')}</b></button>`;
    }).join('');
    $('reportTo').max = localDateKey(new Date());
    $('reportFrom').max = localDateKey(new Date());
  },
  // Validates the range; returns the filtered rows or null.
  collect() {
    const from = $('reportFrom').value;
    const to = $('reportTo').value;
    const fromErr = check(from, [(v) => (!v || /^\d{4}-\d{2}-\d{2}$/.test(v) ? '' : 'Enter a valid start date.')]);
    let toErr = check(to, [(v) => (!v || /^\d{4}-\d{2}-\d{2}$/.test(v) ? '' : 'Enter a valid end date.')]);
    if (!fromErr && !toErr && from && to && from > to) toErr = 'The end date must be on or after the start date.';
    setFieldError($('reportFrom'), fromErr);
    setFieldError($('reportTo'), toErr);
    if (fromErr || toErr) return null;

    const r = REPORTS[this.active];
    let rows = r.rows();
    if (from || to) rows = rows.filter((row) => { const k = localKeyOf(r.date(row)); return k && (!from || k >= from) && (!to || k <= to); });
    return { r, rows };
  },
  preview() {
    const res = this.collect();
    if (!res) return;
    const { r, rows } = res;
    $('reportPreviewWrap').hidden = false;
    $('reportHead').innerHTML = `<tr>${r.cols.map(([h]) => `<th>${esc(h)}</th>`).join('')}</tr>`;
    $('reportBody').innerHTML = rows.slice(0, 25).map((row) => `<tr>${r.cols.map(([, fn]) => `<td>${esc(fn(row) ?? '')}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${r.cols.length}" class="empty-cell">No records in this date range.</td></tr>`;
    $('reportHint').textContent = rows.length > 25 ? `Showing 25 of ${plural(rows.length, 'record')}. The download includes all of them.` : `${plural(rows.length, 'record')} in this report.`;
    return res;
  },
};
VIEWS.reports = reportsView;
$('reportTiles').addEventListener('click', (e) => {
  const b = e.target.closest('[data-report]');
  if (!b) return;
  reportsView.active = b.dataset.report;
  $('reportPreviewWrap').hidden = true;
  $('reportHint').textContent = 'Leave the dates empty to include everything.';
  reportsView.render();
});
$('reportPreview').addEventListener('click', () => reportsView.preview());
$('reportForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const res = reportsView.preview();
  if (!res) return;
  if (!res.rows.length) { toast('Nothing to download for this date range.', true); return; }
  downloadCsv(`${reportsView.active}-report-${localDateKey(new Date())}.csv`, res.r.cols.map(([h]) => h), res.rows.map((row) => res.r.cols.map(([, fn]) => fn(row))));
  toast(`${res.r.title} report downloaded: ${plural(res.rows.length, 'record')}.`);
});

/* ---------------- Farm detail ---------------- */

const LANGS = { en: 'English', hi: 'Hindi', gu: 'Gujarati', mr: 'Marathi', ur: 'Urdu' };
const telHref = (p) => `tel:${esc(String(p).replace(/[^\d+]/g, ''))}`;

const farmView = {
  loading: new Set(),
  errors: new Map(),
  farm() { return store.farms.find((f) => f.id === currentParam); },
  meta() {
    const f = this.farm();
    return [f ? f.farmName || f.id : 'Farm', f ? `${f.id}${f.ownerName ? `, owned by ${f.ownerName}` : ''}` : currentParam];
  },
  actions: () => '<button class="btn btn-quiet btn-sm" type="button" id="farmDetailRefresh">Refresh details</button>',
  enter() { this.load(false); },
  async load(force) {
    const id = currentParam;
    if (!id || this.loading.has(id) || (!force && store.details.has(id))) return;
    this.loading.add(id);
    this.errors.delete(id);
    if (current === 'farm') this.render();
    const btn = $('farmDetailRefresh');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    try {
      store.details.set(id, await getFarmDetail(id));
      if (force) toast('Farm details refreshed.');
    } catch (err) {
      console.error(err);
      this.errors.set(id, friendlyError(err));
    } finally {
      this.loading.delete(id);
      const b = $('farmDetailRefresh');
      if (b) { b.disabled = false; b.textContent = 'Refresh details'; }
      if (current === 'farm' && currentParam === id) this.render();
    }
  },
  render() {
    const box = $('farmDetail');
    const f = this.farm();
    if (!store.loaded.farms) { box.innerHTML = skeletonRows(4, 'skeleton-card'); return; }
    if (!f) { box.innerHTML = `<div class="empty-block"><strong>Farm ${esc(currentParam)} wasn't found.</strong><span>It may have been removed. Go back to the farm list.</span></div>`; return; }
    const [t, sub] = this.meta();
    setTitle(t, sub);
    const d = store.details.get(f.id);
    const err = this.errors.get(f.id);
    const loading = this.loading.has(f.id);
    const v = (x) => (d ? num(x) : '<span class="dim">…</span>');

    const header = `<section class="detail-hero panel">
      <div class="hero-main">
        <span class="avatar lg">${esc(initials(f.farmName))}</span>
        <div class="hero-text">
          <div class="hero-status">${statusPill(f.status)}<span class="dim">${esc(f.subscription?.plan || 'No plan yet')}</span></div>
          ${f.expiryDate && f.status !== 'Blocked' ? runway(f) : f.status === 'Blocked' ? `<p class="hero-note">Blocked ${f.blocked.blockedAt ? `on ${fmtDate(f.blocked.blockedAt)}` : ''}${f.blocked.reason ? `: ${esc(f.blocked.reason)}` : ''}</p>` : f.status === 'Rejected' && f.rejection ? `<p class="hero-note">Rejected${f.rejection.reason ? `: ${esc(f.rejection.reason)}` : ''}</p>` : '<p class="hero-note">Waiting for approval.</p>'}
        </div>
      </div>
      <div class="hero-actions">${farmActions(f)}</div>
    </section>`;

    const totals = `<div class="kpis">
      ${kpi('Goats on the farm', v(d?.totalGoats), d ? `${num(d.palai.active)} Palai, ${num(d.trading.onFarm)} trading, ${num(d.ownGoats)} own` : '')}
      ${kpi('Active partners', d ? num(d.partners.filter((p) => p.status === 'active').length) : v(0), d ? `${num(d.partners.length)} added in total` : '')}
      ${kpi('Palai customers', v(d?.palai.customers), d ? `${plural(d.palai.checkedOut, 'goat')} checked out so far` : '')}
      ${kpi('Trading lots bought', d ? num(d.lots ?? 0) : v(0), d ? plural(d.sales ?? 0, 'sale') : '')}
    </div>`;

    const info = (rows) => `<dl class="details">${rows.filter(Boolean).map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${val}</dd></div>`).join('')}</dl>`;
    const owner = `<article class="panel"><header class="panel-head"><h2>Farmer</h2><p class="muted">Details from the farm's profile in the app.</p></header><div class="panel-body">${info([
      ['Owner', esc(f.ownerName || '—')],
      ['Mobile', f.mobileNumber ? `<a href="${telHref(f.mobileNumber)}">${esc(f.mobileNumber)}</a>` : '—'],
      ['Email', f.email ? `<a href="mailto:${esc(f.email)}">${esc(f.email)}</a>` : '—'],
      ['Address', esc(f.address || '—')],
      ['App language', esc(LANGS[f.preferredLanguage] || f.preferredLanguage || '—')],
      ['Signed up', fmtDate(f.createdAt)],
      f.business?.name ? ['Name on bills', esc(f.business.name)] : null,
      f.business?.phone && f.business.phone !== f.mobileNumber ? ['Phone on bills', esc(f.business.phone)] : null,
    ])}</div></article>`;

    const subscription = `<article class="panel"><header class="panel-head"><h2>Subscription</h2><p class="muted">Set when you approve or renew this farm.</p></header><div class="panel-body">${info([
      ['Plan', esc(f.subscription?.plan || '—')],
      ['Length', f.subscription?.durationDays ? plural(f.subscription.durationDays, 'day') : '—'],
      ['Started', fmtDate(f.startDate)],
      ['Expires', fmtDate(f.expiryDate)],
      ['Approved by', esc(f.approvedBy || '—')],
      f.renewalDate ? ['Last renewed', `${fmtDate(f.renewalDate)}${f.renewedBy ? `, by ${esc(f.renewedBy)}` : ''}`] : null,
    ])}</div></article>`;

    let body = '';
    if (err) body = `<div class="banner" data-tone="error">Couldn't load this farm's partners and goats: ${esc(err)} <button class="btn btn-quiet btn-sm" type="button" id="farmDetailRetry">Try again</button></div>`;

    const partners = !d ? skeletonRows(3) : d.partners.length ? `<div class="table-wrap flat"><table class="table">
      <thead><tr><th>Partner</th><th>Contact</th><th>Status</th><th>Access</th><th>Added</th></tr></thead>
      <tbody>${d.partners.map((p) => `<tr>
        <td class="cell-first"><strong>${esc(p.name || 'Unnamed partner')}</strong></td>
        <td data-label="Contact"><span>${p.mobileNumber ? `<a href="${telHref(p.mobileNumber)}">${esc(p.mobileNumber)}</a>` : '—'}${p.email ? `<span class="dim block">${esc(p.email)}</span>` : ''}</span></td>
        <td data-label="Status">${statusPill(p.status.charAt(0).toUpperCase() + p.status.slice(1))}</td>
        <td data-label="Access">${p.access.length ? `<span class="tags">${p.access.map((a) => `<span class="tag" title="${a.granted} of ${a.total} permissions">${esc(a.group)}</span>`).join('')}</span>` : '<span class="dim">No access given</span>'}</td>
        <td data-label="Added">${fmtDate(p.createdAt)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty-inline">No partners added. The owner adds partners from the app.</p>';

    const goats = !d ? skeletonRows(2) : (() => {
      const rows = [
        ['Palai goats (active)', d.palai.active, 'palai'],
        ...Object.entries(d.trading.byStatus).filter(([st]) => st !== 'Sold' && st !== 'Dead').map(([st, n]) => [`Trading: ${st}`, n, 'trading']),
        ['Own farm goats', d.ownGoats, 'own'],
      ].filter(([, n]) => n > 0);
      const max = Math.max(1, ...rows.map(([, n]) => n));
      const gone = [['Palai goats checked out', d.palai.checkedOut], ['Trading goats sold', d.trading.byStatus.Sold || 0], ['Trading goats died', d.trading.byStatus.Dead || 0]];
      return (rows.length ? `<div class="bars">${rows.map(([label, n, kind]) => `<div class="hbar"><span class="hbar-label">${esc(label)}</span><span class="hbar-track"><span class="hbar-fill k-${kind}" style="width:${(n / max) * 100}%"></span></span><span class="hbar-amt">${num(n)}</span></div>`).join('')}</div>` : '<p class="empty-inline">No goats on this farm right now.</p>')
        + `<dl class="details compact gone">${gone.map(([k, n]) => `<div><dt>${esc(k)}</dt><dd>${num(n)}</dd></div>`).join('')}</dl>`;
    })();

    const customers = !d ? skeletonRows(3) : d.customers.length ? `<div class="table-wrap flat"><table class="table">
      <thead><tr><th>Customer</th><th>Mobile</th><th>Package</th><th class="num">Goats in Palai</th><th>Joined</th></tr></thead>
      <tbody>${d.customers.map((c) => `<tr>
        <td class="cell-first"><strong>${esc(c.name || 'Unnamed')}</strong>${c.address ? `<span class="dim block">${esc(c.address)}</span>` : ''}</td>
        <td data-label="Mobile">${c.mobileNumber ? `<a href="${telHref(c.mobileNumber)}">${esc(c.mobileNumber)}</a>` : '—'}</td>
        <td data-label="Package">${esc(c.package || '—')}</td>
        <td class="num" data-label="Goats in Palai"><span>${num(c.goats.active)}${c.goats.checkedOut ? `<span class="dim block">${num(c.goats.checkedOut)} checked out</span>` : ''}</span></td>
        <td data-label="Joined">${fmtDate(c.joiningDate)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty-inline">No Palai customers yet.</p>';

    const stock = !d ? '' : d.stock === null ? '' : `<article class="panel"><header class="panel-head"><h2>Stock</h2><p class="muted">${d.stock.length ? `${plural(d.stock.length, 'item')}${d.stock.some((x) => x.low) ? `, ${d.stock.filter((x) => x.low).length} running low` : ''}.` : 'No stock items yet.'}</p></header>
      ${d.stock.length ? `<ul class="stock-list">${d.stock.slice(0, 12).map((x) => `<li${x.low ? ' class="low"' : ''}><span>${esc(x.name || 'Item')}</span><strong>${num(x.quantity)} ${esc(x.unit)}</strong></li>`).join('')}</ul>${d.stock.length > 12 ? `<p class="panel-note dim">And ${plural(d.stock.length - 12, 'more item')}.</p>` : ''}` : ''}</article>`;

    box.innerHTML = `${header}${body}${totals}
      <div class="detail-grid">
        ${owner}${subscription}
        <article class="panel span-2"><header class="panel-head"><h2>Partners</h2><p class="muted">People the owner has added to help run the farm. Only active partners can open it.</p></header>${partners}</article>
        <article class="panel"><header class="panel-head"><h2>Goats</h2><p class="muted">Goats on the farm now, by type.</p></header><div class="panel-body">${goats}</div></article>
        ${stock || '<span></span>'}
        <article class="panel span-2"><header class="panel-head"><h2>Palai customers</h2><p class="muted">People who keep their goats at this farm.</p></header>${customers}</article>
      </div>
      ${d ? `<p class="dim updated">Details loaded ${relDay(d.loadedAt).toLowerCase() === 'today' ? `at ${new Date(d.loadedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : relDay(d.loadedAt)}.${loading ? ' Refreshing…' : ''}</p>` : ''}`;
  },
};
VIEWS.farm = farmView;
$('farmDetail').addEventListener('click', (e) => { if (e.target.closest('#farmDetailRetry')) farmView.load(true); });

/* ---------------- Settings ---------------- */

const settingsView = {
  plans: [],
  dirty: false,
  loadedOnce: false,
  contact: { name: '', mobile: '', phones: [], emails: [] },
  contactDirty: false,
  enter() { if (!this.loadedOnce) this.load(); },
  async load() {
    this.loadedOnce = true;
    this.plans = store.plans.map((p) => ({ ...p }));
    this.dirty = false;
    this.renderPlans();
    $('accountEmail').textContent = store.user?.email || '—';
    try {
      store.contact = store.contact || await getAdminContact();
      this.contact = { name: store.contact.name, mobile: store.contact.mobile, phones: [...store.contact.phones], emails: [...store.contact.emails] };
      this.fillContact();
    } catch (err) { toast(friendlyError(err), true); }
  },
  render() { $('accountEmail').textContent = store.user?.email || '—'; },
  renderPlans() {
    $('planGrid').innerHTML = this.plans.map((p, i) => `<fieldset class="plan-card" data-index="${i}">
      <legend>Plan ${i + 1}</legend>
      <div class="field"><label class="field-label" for="plan-name-${i}">Name</label><input class="input" id="plan-name-${i}" data-k="name" value="${esc(p.name)}" maxlength="${LIMITS.planName}" placeholder="e.g. 1 Year"></div>
      <div class="field"><label class="field-label" for="plan-days-${i}">Length in days</label><input class="input" id="plan-days-${i}" data-k="days" type="number" min="1" max="${LIMITS.maxDays}" step="1" inputmode="numeric" value="${esc(p.days)}"></div>
      <button type="button" class="btn btn-text-danger btn-sm" data-remove="${i}"${this.plans.length === 1 ? ' disabled title="Keep at least one plan"' : ''}>Remove plan</button>
    </fieldset>`).join('');
    $('planHint').textContent = this.dirty ? 'You have unsaved changes.' : '';
  },
  validatePlans() {
    let ok = true;
    const names = new Map();
    this.plans.forEach((p, i) => {
      for (const k of ['name', 'days']) {
        const input = $(`plan-${k}-${i}`);
        let msg = check(String(p[k] ?? ''), schemas.plan[k]);
        if (!msg && k === 'name') {
          const key = p.name.trim().toLowerCase();
          if (names.has(key)) msg = 'Another plan already has this name.';
          names.set(key, i);
        }
        setFieldError(input, msg);
        if (msg && ok) { ok = false; input.focus(); }
      }
    });
    return ok;
  },

  /* ---- Support contact ---- */
  fillContact() {
    $('contactName').value = this.contact.name;
    $('contactMobile').value = this.contact.mobile;
    if (!this.contact.emails.length) this.contact.emails.push('');
    this.renderLists();
    this.preview();
  },
  renderLists() {
    for (const kind of ['phones', 'emails']) {
      const list = this.contact[kind];
      const isEmail = kind === 'emails';
      $$(`[data-list="${kind}"]`)[0].innerHTML = list.map((val, i) => `<div class="multi-row">
        <label class="sr-only" for="${kind}-${i}">${isEmail ? `Email ${i + 1}` : `Phone ${i + 1}`}</label>
        <div class="field"><input class="input" id="${kind}-${i}" data-kind="${kind}" data-i="${i}" value="${esc(val)}" ${isEmail ? 'type="email" inputmode="email" maxlength="254" placeholder="name@example.com"' : 'type="tel" inputmode="tel" maxlength="20" placeholder="98765 43210"'}></div>
        <button class="icon-btn" type="button" data-remove-${kind}="${i}" aria-label="Remove ${isEmail ? 'email' : 'phone number'} ${i + 1}"${isEmail && list.length === 1 ? ' disabled' : ''}><svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>`).join('') || `<p class="field-hint">${isEmail ? 'Add at least one email.' : 'None added.'}</p>`;
      $$(`[data-add="${kind}"]`)[0].disabled = list.length >= 5;
    }
  },
  // Live preview of the app's approval-waiting screen.
  preview() {
    const c = this.contact;
    const phones = [c.mobile, ...c.phones].map((x) => x.trim()).filter(Boolean);
    const emails = c.emails.map((x) => x.trim()).filter(Boolean);
    $('contactPreview').innerHTML = `
      <img src="../assets/img/logo.png" alt="" width="44" height="44" class="pv-logo">
      <p class="pv-title">Waiting for approval</p>
      <p class="pv-text">Your farm has been registered. An admin will review it soon.</p>
      <div class="pv-card">
        <p class="pv-label">Need help? Contact</p>
        <p class="pv-name">${esc(c.name.trim() || 'Admin name')}</p>
        ${phones.map((p, i) => `<p class="pv-line"><span class="pv-ico">${i === 0 ? 'M' : 'P'}</span>${esc(p)}${i === 0 ? '<span class="pv-tag">Call · WhatsApp</span>' : ''}</p>`).join('') || '<p class="pv-line dim">Mobile number</p>'}
        ${emails.map((e) => `<p class="pv-line"><span class="pv-ico">@</span>${esc(e)}</p>`).join('') || '<p class="pv-line dim">Email</p>'}
      </div>`;
  },
  validateContact() {
    let first = null;
    const mark = (input, msg) => { setFieldError(input, msg); if (msg && !first) first = input; };
    mark($('contactName'), check(this.contact.name, schemas.contact.name));
    mark($('contactMobile'), check(this.contact.mobile, schemas.contact.mobile));
    const seen = new Set();
    this.contact.phones.forEach((p, i) => {
      let msg = p.trim() ? check(p, schemas.contactPhone) : 'Enter a phone number, or remove this row.';
      if (!msg && seen.has(p.replace(/\D/g, '').slice(-10))) msg = 'This number is already listed.';
      seen.add(p.replace(/\D/g, '').slice(-10));
      mark($(`phones-${i}`), msg);
    });
    const seenMail = new Set();
    this.contact.emails.forEach((e, i) => {
      let msg = e.trim() ? check(e, schemas.contactEmail) : 'Enter an email, or remove this row.';
      if (!msg && seenMail.has(e.trim().toLowerCase())) msg = 'This email is already listed.';
      seenMail.add(e.trim().toLowerCase());
      mark($(`emails-${i}`), msg);
    });
    if (first) first.focus();
    return !first;
  },
  setContactDirty(on) {
    this.contactDirty = on;
    $('contactHint').textContent = on ? 'You have unsaved changes.' : '';
  },
};
VIEWS.settings = settingsView;

$('planGrid').addEventListener('input', (e) => {
  const input = e.target.closest('[data-k]');
  if (!input) return;
  const i = Number(input.closest('[data-index]').dataset.index);
  settingsView.plans[i][input.dataset.k] = input.value; // keep edits when cards re-render
  settingsView.dirty = true;
  $('planHint').textContent = 'You have unsaved changes.';
  if (input.getAttribute('aria-invalid') === 'true') setFieldError(input, check(input.value, schemas.plan[input.dataset.k]));
});
$('planGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  settingsView.plans.splice(Number(b.dataset.remove), 1);
  settingsView.dirty = true;
  settingsView.renderPlans();
});
$('addPlan').addEventListener('click', () => {
  if (settingsView.plans.length >= 20) { toast('Keep it to 20 plans or fewer.', true); return; }
  settingsView.plans.push({ id: `plan-${Date.now()}`, name: '', days: 30 });
  settingsView.dirty = true;
  settingsView.renderPlans();
  $(`plan-name-${settingsView.plans.length - 1}`).focus();
});
$('savePlans').addEventListener('click', async (e) => {
  if (!settingsView.validatePlans()) { toast('Fix the highlighted plan fields, then save.', true); return; }
  await busy(e.currentTarget, 'Saving…', async () => {
    try {
      store.plans = await savePlans(settingsView.plans);
      settingsView.plans = store.plans.map((p) => ({ ...p }));
      settingsView.dirty = false;
      settingsView.renderPlans();
      toast('Plans saved.');
    } catch (err) { toast(friendlyError(err), true); }
  });
});

$('contactForm').addEventListener('input', (e) => {
  const t = e.target;
  const sv = settingsView;
  if (t.id === 'contactName') sv.contact.name = t.value;
  else if (t.id === 'contactMobile') sv.contact.mobile = t.value;
  else if (t.dataset.kind) sv.contact[t.dataset.kind][Number(t.dataset.i)] = t.value;
  else return;
  sv.setContactDirty(true);
  sv.preview();
  if (t.getAttribute('aria-invalid') === 'true') {
    const rule = t.id === 'contactName' ? schemas.contact.name : t.id === 'contactMobile' ? schemas.contact.mobile : t.dataset.kind === 'emails' ? schemas.contactEmail : schemas.contactPhone;
    setFieldError(t, t.value.trim() ? check(t.value, rule) : '');
  }
});
$('contactForm').addEventListener('click', (e) => {
  const sv = settingsView;
  const add = e.target.closest('[data-add]');
  if (add) {
    const kind = add.dataset.add;
    if (sv.contact[kind].length >= 5) return;
    sv.contact[kind].push('');
    sv.renderLists();
    $(`${kind}-${sv.contact[kind].length - 1}`).focus();
    return;
  }
  for (const kind of ['phones', 'emails']) {
    const rm = e.target.closest(`[data-remove-${kind}]`);
    if (rm) {
      sv.contact[kind].splice(Number(rm.getAttribute(`data-remove-${kind}`)), 1);
      sv.setContactDirty(true);
      sv.renderLists();
      sv.preview();
    }
  }
});
$('contactForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sv = settingsView;
  if (!sv.validateContact()) { toast('Fix the highlighted contact fields, then save.', true); return; }
  await busy($('saveContact'), 'Saving…', async () => {
    try {
      store.contact = await saveAdminContact(sv.contact);
      sv.contact = { name: store.contact.name, mobile: store.contact.mobile, phones: [...store.contact.phones], emails: [...store.contact.emails] };
      sv.fillContact();
      sv.setContactDirty(false);
      toast('Support contact saved. The app shows it on the approval screen.');
    } catch (err) {
      toast(err?.code === 'permission-denied'
        ? "Firestore blocked saving the support contact. In Firebase → Firestore → Rules, replace the config/{docId} block with the one from firestore.rules in the repo, publish, then save again."
        : friendlyError(err), true);
    }
  });
});

window.addEventListener('beforeunload', (e) => { if (settingsView.dirty || settingsView.contactDirty) { e.preventDefault(); e.returnValue = ''; } });

/* =====================================================================
   Sign-in page: the visiting goat
   After 5 seconds the page behind blurs and a big goat rises into the
   middle of the screen. It says hi, peeks at the sign-in form, covers
   its eyes with its front legs, says it will come back later and goes.
   Click anywhere (or press Esc) to send it off early. It visits again
   now and then, but never while someone is typing their sign-in.
   ===================================================================== */

const peekGoat = {
  stage: $('goatStage'),
  bubble: $('goatBubble'),
  text: $('goatSays'),
  timers: [],
  running: false,
  visible: false,
  at(ms, fn) { this.timers.push(setTimeout(fn, ms)); },
  clear() { this.timers.forEach(clearTimeout); this.timers = []; },
  cls() { return this.stage.classList; },
  say(words, thought = false) {
    this.text.textContent = words;
    this.bubble.classList.toggle('thought', thought);
    this.bubble.classList.add('show');
    this.cls().add('talk');
    this.at(Math.min(1500, 200 + words.length * 45), () => this.cls().remove('talk'));
  },
  hush() { this.bubble.classList.remove('show'); },
  // Someone has started entering their sign-in: don't interrupt them.
  busyTyping() { return !!($('loginEmail').value || $('loginPassword').value); },
  visit(delay) {
    this.at(delay, () => {
      if (this.busyTyping()) { this.at(15000, () => this.visit(0)); return; }   // try later
      const g = this.cls();
      this.visible = true;
      g.remove('leaving');
      g.add('on');
      requestAnimationFrame(() => g.add('up'));
      this.at(900, () => this.say('Hi!'));
      this.at(2700, () => { this.hush(); g.add('look'); });                       // peeks at the sign-in form
      this.at(4300, () => { g.remove('look'); g.add('shy'); });                   // hooves over its eyes
      this.at(5100, () => this.say("Sorry, I'll come after some time.", true));
      this.at(8600, () => this.leave());
    });
  },
  leave() {
    if (!this.visible) return;
    this.clear();
    this.visible = false;
    this.hush();
    const g = this.cls();
    g.add('leaving');
    g.remove('up', 'talk');
    this.at(700, () => {
      g.remove('on', 'look', 'shy', 'leaving');
      if (this.running) this.visit(60000);                                        // comes back later
    });
  },
  start() {
    if (!this.stage || this.running) return;
    this.running = true;
    this.clear();
    this.visit(5000);  // 5 seconds after the sign-in page appears
  },
  stop() {
    this.running = false;
    this.visible = false;
    this.clear();
    this.hush();
    this.stage?.classList.remove('on', 'up', 'look', 'shy', 'talk', 'leaving');
  },
};
peekGoat.stage?.addEventListener('click', () => peekGoat.leave());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && peekGoat.visible) peekGoat.leave(); });
// Pause while the tab is hidden so the goat doesn't pop up unseen.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) peekGoat.stop();
  else if (document.body.dataset.screen === 'login') peekGoat.start();
});

/* =====================================================================
   Sign in / sign out
   ===================================================================== */

const loginValidator = bindForm({ email: $('loginEmail'), password: $('loginPassword') }, schemas.login);

$('togglePassword').addEventListener('click', () => {
  const input = $('loginPassword');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('togglePassword').setAttribute('aria-pressed', String(show));
  $('togglePassword').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

function loginMessage(code) {
  switch (code) {
    case 'auth/invalid-email': return 'Enter a valid email address.';
    case 'auth/invalid-credential': case 'auth/wrong-password': case 'auth/user-not-found': return 'That email and password don\'t match an account.';
    case 'auth/user-disabled': return 'This account has been disabled in Firebase.';
    case 'auth/too-many-requests': return 'Too many attempts. Wait a few minutes, then try again.';
    case 'auth/network-request-failed': return "Couldn't reach Firebase. Check your connection.";
    case 'not-admin': return "This account isn't an admin. Ask an existing admin to add it in Firebase.";
    default: return 'Sign-in failed. Try again.';
  }
}

let signingIn = false;
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  if (!loginValidator.validate()) return;
  signingIn = true;
  await busy($('loginBtn'), 'Signing in…', async () => {
    try {
      await setPersistence(auth, browserLocalPersistence);
      const { email, password } = loginValidator.values();
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      if (!(await isAdminUid(cred.user.uid))) { await signOut(auth); throw { code: 'not-admin' }; }
      $('loginPassword').value = '';
      enterApp(cred.user);
    } catch (err) {
      $('loginError').textContent = loginMessage(err.code);
    } finally { signingIn = false; }
  });
});

$('signOut').addEventListener('click', async () => {
  if ((settingsView.dirty || settingsView.contactDirty) && !(await confirmAction({ title: 'Sign out with unsaved changes?', text: 'Your unsaved edits in Settings will be lost.', ok: 'Sign out' }))) return;
  storage.del(HINT_KEY);
  stopData();
  settingsView.dirty = false;
  settingsView.contactDirty = false;
  settingsView.loadedOnce = false;
  await signOut(auth);
  showLogin();
});

function showLogin(message = '') {
  document.body.dataset.screen = 'login';
  peekGoat.start();
  document.title = 'Sign in · My Goat Farms Admin';
  $('loginError').textContent = message;
  banner('');
  setTimeout(() => $('loginEmail').focus(), 0);
}

function enterApp(user) {
  store.user = user;
  storage.set(HINT_KEY, user.email || '1');
  $('meEmail').textContent = user.email || 'Admin';
  $('meAvatar').textContent = (user.email || 'A')[0].toUpperCase();
  banner('');
  const wasLogin = document.body.dataset.screen !== 'app';
  document.body.dataset.screen = 'app';
  peekGoat.stop();
  startData();
  showView(routeFromHash(), { focus: wasLogin });
}

// If the session check takes a while (slow network), say so instead of
// leaving a blank or frozen screen.
const slowTimer = setTimeout(() => {
  if (!store.user && document.body.dataset.screen === 'app') banner('Still checking your sign-in. If this doesn\'t finish, check your connection and reload.', 'warn');
}, 6000);

if (document.body.dataset.screen === 'login') peekGoat.start();

// Show the app shell's placeholders immediately for returning admins.
if (document.body.dataset.screen === 'app') {
  $('meEmail').textContent = storage.get(HINT_KEY) || 'Checking sign-in…';
  showView(routeFromHash(), { focus: false });
}

onAuthStateChanged(auth, async (user) => {
  clearTimeout(slowTimer);
  if (signingIn) return; // the login form handles its own result
  if (!user) {
    stopData();
    storage.del(HINT_KEY);
    showLogin();
    return;
  }
  try {
    if (await isAdminUid(user.uid)) enterApp(user);
    else { await signOut(auth); storage.del(HINT_KEY); stopData(); showLogin(loginMessage('not-admin')); }
  } catch (err) {
    // Offline or Firestore unreachable: keep the shell, explain, retry later.
    console.error(err);
    if (document.body.dataset.screen === 'app') banner("Couldn't confirm your admin access. Check your connection; this page will keep trying.", 'warn');
    else showLogin("Couldn't confirm your admin access. Check your connection and try again.");
  }
});
