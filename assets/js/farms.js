import { initAdminShell, toast, esc, fmtDate } from './admin-shell.js';
import {
  watchFarms, approveFarm, renewFarm, rejectFarm, blockFarm, unblockFarm, bulkBlockFarms, getPlans,
} from './db.js';

// Not awaited here on purpose: the sidebar/topbar already paint immediately
// inside initAdminShell(), and the live farms subscription below starts
// right away too, in parallel with this admin check — rather than waiting
// for it to finish first. adminUser is only actually needed later, inside
// the approve/reject/block handlers (at click time, well after this
// resolves).
const adminUserPromise = initAdminShell({ active: 'farms', title: 'Farm Management', subtitle: 'Review, approve and manage every farm subscription.' });
await adminUserPromise;

const $ = (id) => document.getElementById(id);
let farms = [];
let plans = [];
let activeFilter = 'All';
const selected = new Set();

const FILTERS = ['All', 'Pending', 'Active', 'Blocked', 'Rejected', 'Expired'];

/* ---------- Rendering ---------- */

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

function render() {
  const q = $('search').value.trim().toLowerCase();
  const rows = farms.filter(
    (f) =>
      (activeFilter === 'All' || f.status === activeFilter) &&
      [f.farmName, f.ownerName, f.mobileNumber, f.address, f.id].join(' ').toLowerCase().includes(q)
  );

  $('farmTable').innerHTML =
    rows
      .map((f) => {
        const sub = f.subscription
          ? `<div class="cell-strong">${esc(f.subscription.plan)}</div><div class="cell-sub">${f.daysLeft != null ? `${f.daysLeft} days left` : '—'}</div>`
          : '<div class="cell-sub">No subscription yet</div>';
        const initials = (f.farmName || 'F').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase();
        return `
      <tr>
        <td class="check-cell"><input type="checkbox" class="row-check" data-id="${esc(f.id)}" ${selected.has(f.id) ? 'checked' : ''}></td>
        <td><div class="user-cell">
          <div class="avatar">${esc(initials)}</div>
          <div><div class="user-name">${esc(f.farmName)}</div><div class="cell-mono">ID: ${esc(f.id)}</div></div>
        </div></td>
        <td><div class="cell-strong">${esc(f.ownerName)}</div><div class="cell-sub">${esc(f.mobileNumber)}</div></td>
        <td>${sub}</td>
        <td><span class="badge ${f.status}">${esc(f.status)}</span></td>
        <td>${rowActions(f)}</td>
      </tr>`;
      })
      .join('') || '<tr><td colspan="6" class="empty-row">No farm records found.</td></tr>';

  $('totalFarms').textContent = farms.length;
  $('activeFarms').textContent = farms.filter((f) => f.status === 'Active').length;
  $('pendingFarms').textContent = farms.filter((f) => f.status === 'Pending').length;
  $('blockedFarms').textContent = farms.filter((f) => f.status === 'Blocked').length;
  renderPills();
  renderSelectBar();
}

function renderSelectBar() {
  const bar = $('selectBar');
  bar.classList.toggle('show', selected.size > 0);
  $('selectCount').textContent = `${selected.size} selected`;
  $('headCheck').checked = selected.size > 0 && selected.size === document.querySelectorAll('.row-check').length;
}

// Live subscription: approve/reject/renew/block/unblock all show up here
// automatically (including this admin's own action, echoed straight back
// through the same listener) — nothing below needs to call load() again.
watchFarms(
  (list) => { farms = list; render(); },
  (err) => toast(err.message, true)
);

async function loadPlans() {
  try {
    plans = await getPlans();
    $('subPlan').innerHTML = plans.map((p) => `<option value="${esc(p.name)}" data-days="${p.days}" data-amount="${p.amount}">${esc(p.name)} — ₹${p.amount} / ${p.days} days</option>`).join('');
  } catch { /* plans are optional to load; approve modal still works with manual entry */ }
}

/* ---------- Approve / Renew modal ---------- */

function openSubModal(f, mode) {
  $('subModalTitle').textContent = mode === 'approve' ? 'Approve Farm' : 'Renew Subscription';
  $('subNote').textContent =
    mode === 'approve'
      ? 'The subscription countdown starts on the date you approve this farm, not the registration date.'
      : 'Renewing extends the current expiry date (or starts from today if already expired).';
  $('subFarmId').value = f.id;
  $('subFarmId').dataset.mode = mode;
  const firstPlan = plans[0];
  $('subPlan').value = f.subscription?.plan || firstPlan?.name || '';
  $('subDuration').value = f.subscription?.durationDays || firstPlan?.days || 365;
  $('subAmount').value = f.subscription?.amount || firstPlan?.amount || '';
  $('subPaymentStatus').value = f.payment?.status || 'Paid';
  $('subPaymentDate').value = new Date().toISOString().slice(0, 10);
  $('subPaymentRef').value = '';
  $('subModal').classList.remove('hidden');
}
const closeSubModal = () => $('subModal').classList.add('hidden');
$('closeSubModal').addEventListener('click', closeSubModal);
$('cancelSubModal').addEventListener('click', closeSubModal);

$('subPlan').addEventListener('change', (e) => {
  const opt = e.target.selectedOptions[0];
  if (opt?.dataset.days) $('subDuration').value = opt.dataset.days;
  if (opt?.dataset.amount) $('subAmount').value = opt.dataset.amount;
});

$('subForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('subFarmId').value;
  const mode = $('subFarmId').dataset.mode;
  const body = {
    plan: $('subPlan').value || 'Custom Plan',
    durationDays: Number($('subDuration').value) || 1,
    amount: Number($('subAmount').value) || 0,
    paymentStatus: $('subPaymentStatus').value,
    paymentDate: $('subPaymentDate').value,
    paymentReference: $('subPaymentRef').value.trim(),
  };
  const btn = $('saveSub');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    if (mode === 'approve') await approveFarm(id, body, (await adminUserPromise).email);
    else await renewFarm(id, body);
    closeSubModal();
    toast(mode === 'approve' ? 'Farm approved and activated.' : 'Subscription renewed.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm';
  }
});

/* ---------- Reject / Block modal ---------- */

function openReasonModal(f, action) {
  $('reasonModalTitle').textContent = action === 'reject' ? 'Reject Farm' : 'Block Farm';
  $('reasonFarmId').value = f.id;
  $('reasonAction').value = action;
  $('reasonText').value = '';
  $('confirmReason').textContent = action === 'reject' ? 'Reject Farm' : 'Confirm Block';
  $('reasonModal').classList.remove('hidden');
}
const closeReasonModal = () => $('reasonModal').classList.add('hidden');
$('closeReasonModal').addEventListener('click', closeReasonModal);
$('cancelReasonModal').addEventListener('click', closeReasonModal);

$('reasonForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('reasonFarmId').value;
  const action = $('reasonAction').value;
  try {
    if (action === 'reject') await rejectFarm(id, $('reasonText').value.trim(), (await adminUserPromise).email);
    else await blockFarm(id, $('reasonText').value.trim(), (await adminUserPromise).email);
    closeReasonModal();
    toast(action === 'reject' ? 'Farm rejected.' : 'Farm blocked.');
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- View detail modal ---------- */

function openViewModal(f) {
  $('viewModalTitle').textContent = f.farmName;
  const rows = [
    ['Farm ID', f.id],
    ['Owner', f.ownerName],
    ['Mobile', f.mobileNumber],
    ['Email', f.email || '—'],
    ['Address', f.address || '—'],
    ['Status', f.status],
    ['Plan', f.subscription?.plan || '—'],
    ['Subscription Amount', f.subscription ? `₹${f.subscription.amount}` : '—'],
    ['Approval Date', fmtDate(f.approvalDate)],
    ['Subscription Start', fmtDate(f.startDate)],
    ['Subscription Expiry', fmtDate(f.expiryDate)],
    ['Days Left', f.daysLeft != null ? f.daysLeft : '—'],
    ['Payment Status', f.payment?.status || '—'],
    ['Payment Reference', f.payment?.reference || '—'],
    ['Blocked', f.blocked?.blocked ? `Yes — ${f.blocked.reason || 'no reason given'}` : 'No'],
    ['Rejection Reason', f.rejection?.reason || '—'],
  ];
  $('viewBody').innerHTML = rows
    .map(([label, value]) => `<div class="detail-item"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`)
    .join('');
  $('viewModal').classList.remove('hidden');
}
$('closeViewModal').addEventListener('click', () => $('viewModal').classList.add('hidden'));

/* ---------- Table interactions ---------- */

$('search').addEventListener('input', render);

$('statusPills').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  render();
});

$('farmTable').addEventListener('change', (e) => {
  if (!e.target.classList.contains('row-check')) return;
  const id = e.target.dataset.id;
  if (e.target.checked) selected.add(id); else selected.delete(id);
  renderSelectBar();
});

$('headCheck').addEventListener('change', (e) => {
  document.querySelectorAll('.row-check').forEach((cb) => {
    cb.checked = e.target.checked;
    if (e.target.checked) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id);
  });
  renderSelectBar();
});

$('farmTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const farm = farms.find((f) => f.id === btn.dataset.id);
  if (!farm) return;
  const action = btn.dataset.action;

  if (action === 'view') return openViewModal(farm);
  if (action === 'approve') return openSubModal(farm, 'approve');
  if (action === 'renew') return openSubModal(farm, 'renew');
  if (action === 'reject') return openReasonModal(farm, 'reject');
  if (action === 'block') return openReasonModal(farm, 'block');

  if (action === 'unblock') {
    if (!confirm(`Unblock "${farm.farmName}"?`)) return;
    unblockFarm(farm.id)
      .then(() => toast('Farm unblocked.'))
      .catch((err) => toast(err.message, true));
  }
});

/* ---------- Bulk actions ---------- */

$('bulkBlockBtn').addEventListener('click', async () => {
  if (!selected.size) return;
  const reason = prompt(`Block ${selected.size} selected farm(s). Reason (optional):`, '');
  if (reason === null) return;
  try {
    await bulkBlockFarms([...selected], reason, (await adminUserPromise).email);
    toast(`${selected.size} farm(s) blocked.`);
    selected.clear();
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  [$('subModal'), $('reasonModal'), $('viewModal')].forEach((m) => m.classList.add('hidden'));
});

/* ---------- Boot ---------- */
loadPlans();
