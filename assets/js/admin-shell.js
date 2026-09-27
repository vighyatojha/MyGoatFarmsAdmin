import { requireAdmin, logout } from './auth-guard.js';

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
  farms: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  subscriptions: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  payments: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
  earnings: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  enquiries: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  reports: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

const NAV = [
  { key: 'dashboard', href: '/admin/dashboard.html', label: 'Dashboard' },
  { key: 'farms', href: '/admin/farms.html', label: 'Farms' },
  { key: 'subscriptions', href: '/admin/subscriptions.html', label: 'Subscriptions' },
  { key: 'payments', href: '/admin/payments.html', label: 'Payments' },
  { key: 'earnings', href: '/admin/earnings.html', label: 'Earnings' },
  { key: 'enquiries', href: '/admin/enquiries.html', label: 'Enquiries' },
  { key: 'reports', href: '/admin/reports.html', label: 'Reports' },
  { key: 'settings', href: '/admin/settings.html', label: 'Settings' },
];

const icon = (name) => `<svg class="svg-icon" viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;

function sidebarHtml(active) {
  const links = NAV.map(
    (item) => `
      <a class="side-link${item.key === active ? ' active' : ''}" href="${item.href}">
        ${icon(item.key)}
        <span>${item.label}</span>
      </a>`
  ).join('');

  return `
    <a class="brand sidebar-brand" href="/">
      <span class="logo-ring"><img src="/assets/img/logo.png" alt="" width="36" height="36"></span>
      <span class="brand-name">My Goat Farms</span>
    </a>
    <div class="side-label">ADMINISTRATION</div>
    <nav class="side-nav">${links}</nav>
    <div class="sidebar-bottom">
      <button id="shellLogout" class="side-link" type="button">
        <svg class="svg-icon" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        <span>Logout</span>
      </button>
    </div>`;
}

function topbarHtml(title, subtitle, email) {
  return `
    <div>
      <h1>${title}</h1>
      ${subtitle ? `<p>${subtitle}</p>` : ''}
    </div>
    <div class="admin-profile">
      <div class="admin-avatar">${(email || 'A')[0].toUpperCase()}</div>
      <div class="admin-profile-info"><div>${email || 'Admin'}</div><span>Administrator</span></div>
    </div>`;
}

/**
 * Mounts the shared sidebar (#sidebarRoot) and topbar (#topbarRoot) right
 * away — the nav itself doesn't need to know who's signed in, so it no
 * longer waits on the admin check first. That check (an onAuthStateChanged
 * settle + a Firestore round trip) used to run BEFORE anything was painted,
 * which is what left the page blank/stuck for however long that took.
 *
 * The admin check still runs, in the background: it confirms the visitor is
 * a signed-in admin (redirecting to /admin/ otherwise), then fills in the
 * topbar's email once resolved. Resolves with the signed-in Firebase user,
 * so callers that need it (e.g. to stamp an approvedBy/blockedBy email) can
 * still `await initAdminShell(...)`.
 */
export async function initAdminShell({ active, title, subtitle }) {
  const sidebarRoot = document.getElementById('sidebarRoot');
  const topbarRoot = document.getElementById('topbarRoot');

  if (sidebarRoot) sidebarRoot.innerHTML = sidebarHtml(active);
  if (topbarRoot) topbarRoot.innerHTML = topbarHtml(title, subtitle, null);
  document.getElementById('shellLogout')?.addEventListener('click', logout);

  let user;
  try {
    user = await requireAdmin();
  } catch (err) {
    // Timed out rather than resolving/redirecting — the shell is already
    // visible, so surface it instead of leaving the page silently stuck.
    toast(err.message, true);
    throw err;
  }

  if (topbarRoot) topbarRoot.innerHTML = topbarHtml(title, subtitle, user.email);
  document.getElementById('shellLogout')?.addEventListener('click', logout);

  return user;
}

export function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtMoney(n) {
  return '₹' + (Number(n) || 0).toLocaleString('en-IN');
}
