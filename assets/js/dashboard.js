import { initAdminShell, toast, esc, fmtDate } from './admin-shell.js';
import {
  watchFarms, watchEnquiries, getFarmOperationalStats,
  approveFarm, renewFarm, rejectFarm, blockFarm, unblockFarm,
  getPlans, listFarms, listEnquiries
} from './db.js';

const adminUserPromise = initAdminShell({
  active: 'dashboard',
  title: 'Admin Dashboard',
  subtitle: 'Manage farms, access, enquiries and operational reports from one place.'
});

const $ = (id) => document.getElementById(id);
let farms = [];
let enquiries = [];
let plans = [];
let farmStats = {};
let activeFilter = 'All';

const FILTERS = ['All', 'Pending', 'Active', 'Blocked', 'Rejected', 'Expired'];

function renderPills() {
  $('statusPills').innerHTML = FILTERS.map((f) => {
    const count = f === 'All' ? farms.length : farms.filter((x) => x.status === f).length;
    return `<button type="button" class="pill${f === activeFilter ? ' active' : ''}" data-filter="${f}">${f} <span class="count">${count}</span></button>`;
  }).join('');
}

function rowActions(f) {
  const btns = [`<button class="action-btn" type="button" data-action="view" data-id="${esc(f.id)}">View</button>`];
  if (f.status === 'Pending') {
    btns.push(`<button class="action-btn" type="button" data-action="approve" data-id="${esc(f.id)}">Approve</button>`);
    btns.push(`<button class="action-btn danger" type="button" data-action="reject" data-id="${esc(f.id)}">Reject</button>`);
  } else if (f.status === 'Active' || f.status === 'Expired') {
    btns.push(`<button class="action-btn" type="button" data-action="renew" data-id="${esc(f.id)}">Renew</button>`);
    btns.push(`<button class="action-btn danger" type="button" data-action="block" data-id="${esc(f.id)}">Block</button>`);
  } else if (f.status === 'Blocked') {
    btns.push(`<button class="action-btn" type="button" data-action="unblock" data-id="${esc(f.id)}">Unblock</button>`);
  } else if (f.status === 'Rejected') {
    btns.push(`<button class="action-btn" type="button" data-action="approve" data-id="${esc(f.id)}">Approve</button>`);
  }
  return btns.join('');
}

function renderFarms() {
  const q = $('farmSearch').value.trim().toLowerCase();
  const rows = farms.filter((f) =>
    (activeFilter === 'All' || f.status === activeFilter) &&
    [f.farmName, f.ownerName, f.mobileNumber, f.address, f.id].join(' ').toLowerCase().includes(q)
  );

  $('farmTable').innerHTML = rows.map((f) => {
    const s = farmStats[f.id] || {};
    const initials = (f.farmName || 'F').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase();
    return `<tr>
      <td><div class="user-cell"><div class="avatar">${esc(initials)}</div><div><div class="user-name">${esc(f.farmName)}</div><div class="cell-sub">${esc(f.ownerName)}</div></div></div></td>
      <td class="cell-mono">${esc(f.id)}</td>
      <td><div class="cell-strong">${esc(f.ownerName)}</div><div class="cell-sub">${esc(f.mobileNumber)}</div></td>
      <td>${s.partners ?? '—'}</td><td>${s.palaiGoats ?? '—'}</td><td>${s.tradingGoats ?? '—'}</td>
      <td><span class="badge ${esc(f.status)}">${esc(f.status)}</span></td><td>${rowActions(f)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty-row">No farms found.</td></tr>';

  $('statTotalFarms').textContent = farms.length;
  $('statPending').textContent = farms.filter((f) => f.status === 'Pending').length;
  $('statActive').textContent = farms.filter((f) => f.status === 'Active').length;
  $('statBlocked').textContent = farms.filter((f) => f.status === 'Blocked').length;
  renderPills();
}

function renderSubscriptions() {
  const rows = farms.filter((f) => f.subscription);
  $('subscriptionTable').innerHTML = rows.map((f) => `<tr>
    <td><strong>${esc(f.farmName)}</strong></td><td class="cell-mono">${esc(f.id)}</td>
    <td>${esc(f.subscription.plan)}</td><td>${fmtDate(f.startDate)}</td><td>${fmtDate(f.expiryDate)}</td>
    <td><strong>${f.daysLeft ?? '—'}</strong></td><td><span class="badge ${esc(f.status)}">${esc(f.status)}</span></td>
    <td>${f.status !== 'Pending' ? `<button class="action-btn" data-sub-renew="${esc(f.id)}">Renew</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="8" class="empty-row">No subscriptions found.</td></tr>';
}

function renderEnquiries() {
  $('enquiryActivity').innerHTML = enquiries.slice(0, 15).map((e) => `<div class="activity-row">
    <div class="activity-main"><strong>${esc(e.name)} — ${esc(e.subject)}</strong><span>${esc(e.email)} · ${esc(e.status)}</span></div>
    <time>${fmtDate(e.receivedAt)}</time>
  </div>`).join('') || '<p class="empty-row">No enquiries yet.</p>';
}

async function refreshFarmStats() {
  const results = await Promise.all(farms.map(async (f) => {
    try { return [f.id, await getFarmOperationalStats(f.id)]; }
    catch { return [f.id, {}]; }
  }));
  farmStats = Object.fromEntries(results);
  renderFarms();
}

function render() {
  renderFarms();
  renderSubscriptions();
  renderEnquiries();
  refreshFarmStats().catch((err) => toast(err.message, true));
}

function openSubModal(f, mode) {
  $('subModalTitle').textContent = mode === 'approve' ? 'Approve Farm' : 'Renew Subscription';
  $('subNote').textContent = mode === 'approve'
    ? 'Choose the access plan and duration. No payment information is collected here.'
    : 'Extend the farm access period. No payment information is collected here.';
  $('subFarmId').value = f.id;
  $('subFarmId').dataset.mode = mode;
  const first = plans[0];
  $('subPlan').value = f.subscription?.plan || first?.name || '';
  $('subDuration').value = f.subscription?.durationDays || first?.days || 365;
  $('subModal').classList.remove('hidden');
}

function openReasonModal(f, action) {
  $('reasonModalTitle').textContent = action === 'reject' ? 'Reject Farm' : 'Block Farm';
  $('reasonFarmId').value = f.id;
  $('reasonAction').value = action;
  $('reasonText').value = '';
  $('confirmReason').textContent = action === 'reject' ? 'Reject Farm' : 'Confirm Block';
  $('reasonModal').classList.remove('hidden');
}

function openViewModal(f) {
  const s = farmStats[f.id] || {};
  $('viewModalTitle').textContent = f.farmName;
  const rows = [
    ['Farm ID', f.id], ['Owner', f.ownerName], ['Mobile', f.mobileNumber], ['Email', f.email || '—'],
    ['Partners', s.partners ?? '—'], ['Palai Goats', s.palaiGoats ?? '—'], ['Trading Goats', s.tradingGoats ?? '—'],
    ['Status', f.status], ['Plan', f.subscription?.plan || '—'], ['Start', fmtDate(f.startDate)],
    ['Expiry', fmtDate(f.expiryDate)], ['Days Left', f.daysLeft ?? '—']
  ];
  $('viewBody').innerHTML = rows.map(([label, value]) =>
    `<div class="detail-item"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`
  ).join('');
  $('viewModal').classList.remove('hidden');
}

async function loadPlans() {
  try {
    plans = await getPlans();
    $('subPlan').innerHTML = plans.map((p) =>
      `<option value="${esc(p.name)}" data-days="${p.days}">${esc(p.name)} — ${p.days} days</option>`
    ).join('');
  } catch (err) { toast(err.message, true); }
}

async function downloadReport(type) {
  let data;
  let columns;
  if (type === 'farm') {
    data = await listFarms();
    const stats = await Promise.all(data.map(async (f) => [f.id, await getFarmOperationalStats(f.id).catch(() => ({}))]));
    const byId = Object.fromEntries(stats);
    data = data.map((f) => ({ ...f, ...(byId[f.id] || {}) }));
    columns = [['id','Farm ID'],['farmName','Farm Name'],['ownerName','Owner'],['mobileNumber','Mobile'],['status','Status'],['partners','Partners'],['palaiGoats','Palai Goats'],['tradingGoats','Trading Goats']];
  } else if (type === 'subscription') {
    data = (await listFarms()).filter((f) => f.subscription);
    columns = [['id','Farm ID'],['farmName','Farm'],['status','Status'],['plan','Plan',f=>f.subscription?.plan],['startDate','Start',f=>fmtDate(f.startDate)],['expiryDate','Expiry',f=>fmtDate(f.expiryDate)],['daysLeft','Days Left']];
  } else {
    data = await listEnquiries();
    columns = [['name','Name'],['email','Email'],['phone','Phone'],['subject','Subject'],['status','Status'],['receivedAt','Received',e=>fmtDate(e.receivedAt)]];
  }
  const csv = [
    columns.map(([, label]) => `"${label.replace(/"/g,'""')}"`).join(','),
    ...data.map((row) => columns.map(([key,,fn]) => `"${String(fn ? fn(row) : row[key] ?? '').replace(/"/g,'""')}"`).join(','))
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8;'}));
  a.download = `${type}-report-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`${type[0].toUpperCase()+type.slice(1)} report downloaded.`);
}

watchFarms((list) => { farms = list; render(); }, (err) => toast(err.message, true));
watchEnquiries((list) => { enquiries = list; renderEnquiries(); }, (err) => toast(err.message, true));

$('farmSearch').addEventListener('input', renderFarms);
$('statusPills').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  renderFarms();
});

document.querySelectorAll('.dashboard-tab').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.dashboard-tab').forEach((x) => x.classList.toggle('active', x === btn));
  document.querySelectorAll('.dashboard-section').forEach((x) => x.classList.toggle('active', x.id === `section-${btn.dataset.section}`));
}));

$('farmTable').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const f = farms.find((x) => x.id === btn.dataset.id);
  if (!f) return;
  if (btn.dataset.action === 'view') openViewModal(f);
  if (btn.dataset.action === 'approve') openSubModal(f, 'approve');
  if (btn.dataset.action === 'renew') openSubModal(f, 'renew');
  if (btn.dataset.action === 'reject') openReasonModal(f, 'reject');
  if (btn.dataset.action === 'block') openReasonModal(f, 'block');
  if (btn.dataset.action === 'unblock') {
    if (!confirm(`Unblock "${f.farmName}"?`)) return;
    unblockFarm(f.id).then(() => toast('Farm unblocked.')).catch((err) => toast(err.message, true));
  }
});

$('subscriptionTable').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sub-renew]');
  if (!btn) return;
  const f = farms.find((x) => x.id === btn.dataset.subRenew);
  if (f) openSubModal(f, 'renew');
});

$('subForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('subFarmId').value;
  const body = { plan: $('subPlan').value || 'Custom Plan', durationDays: Number($('subDuration').value) || 1 };
  const btn = $('saveSub');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    if ($('subFarmId').dataset.mode === 'approve') await approveFarm(id, body, (await adminUserPromise).email);
    else await renewFarm(id, body);
    $('subModal').classList.add('hidden');
    toast($('subFarmId').dataset.mode === 'approve' ? 'Farm approved and activated.' : 'Subscription renewed.');
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Confirm'; }
});

$('reasonForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('reasonFarmId').value;
  const action = $('reasonAction').value;
  try {
    if (action === 'reject') await rejectFarm(id, $('reasonText').value.trim(), (await adminUserPromise).email);
    else await blockFarm(id, $('reasonText').value.trim(), (await adminUserPromise).email);
    $('reasonModal').classList.add('hidden');
    toast(action === 'reject' ? 'Farm rejected.' : 'Farm blocked.');
  } catch (err) { toast(err.message, true); }
});

document.querySelectorAll('[data-report]').forEach((btn) => btn.addEventListener('click', () => downloadReport(btn.dataset.report).catch((err) => toast(err.message, true))));

$('closeSubModal').addEventListener('click', () => $('subModal').classList.add('hidden'));
$('cancelSubModal').addEventListener('click', () => $('subModal').classList.add('hidden'));
$('closeReasonModal').addEventListener('click', () => $('reasonModal').classList.add('hidden'));
$('cancelReasonModal').addEventListener('click', () => $('reasonModal').classList.add('hidden'));
$('closeViewModal').addEventListener('click', () => $('viewModal').classList.add('hidden'));
$('subPlan').addEventListener('change', (e) => { const o = e.target.selectedOptions[0]; if (o?.dataset.days) $('subDuration').value = o.dataset.days; });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ['subModal','reasonModal','viewModal'].forEach((id) => $(id).classList.add('hidden'));
});

loadPlans();
