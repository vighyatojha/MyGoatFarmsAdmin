import { initAdminShell, esc, fmtDate, toast } from './admin-shell.js';
import { watchFarms, watchEnquiries, getFarmOperationalStats } from './db.js';

// Not awaited: the shell paints immediately inside initAdminShell(), and the
// live subscriptions below start fetching this page's data right away too,
// in parallel with the admin check, instead of waiting for it first.
initAdminShell({ active: 'dashboard', title: 'Dashboard', subtitle: 'An overview of farms, subscriptions and enquiries.' });

// Each stream keeps its own latest snapshot; render() re-draws the whole
// dashboard from whichever streams have reported in so far, and runs again
// every time any one of them updates (a new farm, enquiry, or payment).
let farms = [];
let enquiries = [];
let farmStats = {};

async function renderFarmOverview() {
  const box = document.getElementById('farmOverviewTable');
  if (!box) return;
  const rows = farms.slice(0, 10);
  if (!rows.length) { box.innerHTML = '<tr><td colspan="7" class="empty-row">No farms yet.</td></tr>'; return; }
  const stats = await Promise.all(rows.map(async (f) => [f.id, await getFarmOperationalStats(f.id)]));
  farmStats = Object.fromEntries(stats);
  box.innerHTML = rows.map((f) => {
    const s = farmStats[f.id] || {};
    return `<tr><td><strong>${esc(f.farmName)}</strong><div class="cell-sub">${esc(f.ownerName)}</div></td><td class="cell-mono">${esc(f.id)}</td><td>${s.partners ?? '—'}</td><td>${s.palaiGoats ?? '—'}</td><td>${s.tradingGoats ?? '—'}</td><td><span class="badge ${esc(f.status)}">${esc(f.status)}</span></td><td><button class="action-btn" type="button" data-dashboard-farm="${esc(f.id)}">View</button></td></tr>`;
  }).join('');
}

function renderSubscriptionOverview() {
  const box = document.getElementById('subscriptionOverview');
  if (!box) return;
  const rows = farms.filter((f) => f.subscription).slice(0, 6);
  box.innerHTML = rows.map((f) => `<tr><td><strong>${esc(f.farmName)}</strong><div class="cell-mono">${esc(f.id)}</div></td><td>${esc(f.subscription.plan)}</td><td>${f.daysLeft ?? '—'}</td><td><span class="badge ${esc(f.status)}">${esc(f.status)}</span></td></tr>`).join('') || '<tr><td colspan="4" class="empty-row">No active subscriptions.</td></tr>';
}

function render() {
  document.getElementById('statPending').textContent = farms.filter((f) => f.status === 'Pending').length;
  document.getElementById('statActive').textContent = farms.filter((f) => f.status === 'Active').length;
  document.getElementById('statBlocked').textContent = farms.filter((f) => f.status === 'Blocked').length;
  document.getElementById('statTotalFarms').textContent = farms.length;

  const enqBox = document.getElementById('enquiryActivity');
  enqBox.innerHTML =
    enquiries
      .slice(0, 5)
      .map(
        (e) => `
    <div class="activity-row">
      <div class="activity-main"><strong>${esc(e.name)} — ${esc(e.subject)}</strong><span>${esc(e.email)}</span></div>
      <time>${fmtDate(e.receivedAt)}</time>
    </div>`
      )
      .join('') || '<p class="empty-row">No enquiries yet.</p>';

  renderSubscriptionOverview();
  renderFarmOverview().catch((err) => toast(err.message, true));

  const farmBox = document.getElementById('farmActivity');
  const recentFarms = [...farms].sort((a, b) => (b.approvalDate || '').localeCompare(a.approvalDate || '')).slice(0, 5);
  farmBox.innerHTML =
    recentFarms
      .map(
        (f) => `
    <div class="activity-row">
      <div class="activity-main"><strong>${esc(f.farmName)}</strong><span>${esc(f.ownerName)} · <span class="badge ${f.status}">${esc(f.status)}</span></span></div>
      <time>${fmtDate(f.approvalDate)}</time>
    </div>`
      )
      .join('') || '<p class="empty-row">No farms yet.</p>';
}

watchFarms((list) => { farms = list; render(); }, (err) => toast(err.message, true));
watchEnquiries((list) => { enquiries = list; render(); }, (err) => toast(err.message, true));

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-dashboard-farm]');
  if (!btn) return;
  const farm = farms.find((f) => f.id === btn.dataset.dashboardFarm);
  if (!farm) return;
  const s = farmStats[farm.id] || {};
  document.getElementById('farmDetailTitle').textContent = farm.farmName;
  document.getElementById('farmDetailBody').innerHTML = [
    ['Farm ID', farm.id], ['Owner', farm.ownerName], ['Mobile', farm.mobileNumber], ['Email', farm.email || '—'],
    ['Partners', s.partners ?? '—'], ['Palai Goats', s.palaiGoats ?? '—'], ['Trading Goats', s.tradingGoats ?? '—'],
    ['Status', farm.status], ['Plan', farm.subscription?.plan || '—'], ['Expiry', fmtDate(farm.expiryDate)], ['Days Left', farm.daysLeft ?? '—']
  ].map(([label,value]) => `<div class="detail-item"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`).join('');
  document.getElementById('farmDetailModal').classList.remove('hidden');
});
document.getElementById('closeFarmDetail')?.addEventListener('click', () => document.getElementById('farmDetailModal').classList.add('hidden'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('farmDetailModal')?.classList.add('hidden'); });