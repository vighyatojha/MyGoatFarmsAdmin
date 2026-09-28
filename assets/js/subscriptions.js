import { initAdminShell, toast, esc, fmtDate } from './admin-shell.js';
import { watchFarms, renewFarm, getPlans } from './db.js';

// Not awaited: see dashboard.js/admin-shell.js — shell paints immediately,
// the live farms subscription below starts in parallel with the admin check.
initAdminShell({ active: 'subscriptions', title: 'Subscriptions', subtitle: "Countdown starts from each farm's approval date." });

const $ = (id) => document.getElementById(id);
let farms = [];
let plans = [];
let activeFilter = 'All';

const FILTERS = ['All', 'Active', 'Expiring Soon', 'Expired', 'Pending'];

function matchesFilter(f, filter) {
  if (filter === 'All') return true;
  if (filter === 'Expiring Soon') return f.status === 'Active' && f.daysLeft != null && f.daysLeft <= 15;
  return f.status === filter;
}

function renderPills() {
  $('statusPills').innerHTML = FILTERS.map((f) => {
    const count = farms.filter((x) => matchesFilter(x, f)).length;
    return `<button type="button" class="pill${f === activeFilter ? ' active' : ''}" data-filter="${f}">${f} <span class="count">${count}</span></button>`;
  }).join('');
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const subs = farms.filter((f) => f.subscription);
  const rows = subs.filter(
    (f) => matchesFilter(f, activeFilter) && [f.farmName, f.subscription?.plan].join(' ').toLowerCase().includes(q)
  );

  $('subTable').innerHTML =
    rows
      .map(
        (f) => `
    <tr>
      <td><div class="user-name">${esc(f.farmName)}</div><div class="cell-mono">${esc(f.id)}</div></td>
      <td>${esc(f.subscription.plan)}</td>
      <td>${fmtDate(f.startDate)}</td>
      <td>${fmtDate(f.expiryDate)}</td>
      <td><strong>${f.daysLeft != null ? f.daysLeft : '—'}</strong></td>
      <td><span class="badge ${f.status}">${esc(f.status)}</span></td>
      <td>
        ${f.status !== 'Pending' ? `<button class="action-btn" type="button" data-action="renew" data-id="${esc(f.id)}">Extend / Renew</button>` : ''}
        <a class="action-btn" href="/admin/farms.html">View in Farms</a>
      </td>
    </tr>`
      )
      .join('') || '<tr><td colspan="7" class="empty-row">No subscriptions found.</td></tr>';

  $('statActive').textContent = farms.filter((f) => f.status === 'Active').length;
  $('statExpiring').textContent = farms.filter((f) => matchesFilter(f, 'Expiring Soon')).length;
  $('statExpired').textContent = farms.filter((f) => f.status === 'Expired').length;
  $('statPending').textContent = farms.filter((f) => f.status === 'Pending').length;
  renderPills();
}

// Live subscription: a renewal on this page, or an approve/renew/block done
// from the Farms page, shows up here automatically — no reload needed.
watchFarms(
  (list) => { farms = list; render(); },
  (err) => toast(err.message, true)
);

async function loadPlans() {
  try {
    plans = await getPlans();
    $('subPlan').innerHTML = plans.map((p) => `<option value="${esc(p.name)}" data-days="${p.days}" data-amount="${p.amount}">${esc(p.name)} — ₹${p.amount} / ${p.days} days</option>`).join('');
  } catch { /* optional */ }
}

$('search').addEventListener('input', render);
$('statusPills').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  render();
});

function openSubModal(f) {
  $('subFarmId').value = f.id;
  const firstPlan = plans[0];
  $('subPlan').value = f.subscription?.plan || firstPlan?.name || '';
  $('subDuration').value = firstPlan?.days || f.subscription?.durationDays || 365;
  $('subModal').classList.remove('hidden');
}
const closeSubModal = () => $('subModal').classList.add('hidden');
$('closeSubModal').addEventListener('click', closeSubModal);
$('cancelSubModal').addEventListener('click', closeSubModal);
$('subPlan').addEventListener('change', (e) => {
  const opt = e.target.selectedOptions[0];
  if (opt?.dataset.days) $('subDuration').value = opt.dataset.days;
});

$('subTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action="renew"]');
  if (!btn) return;
  const farm = farms.find((f) => f.id === btn.dataset.id);
  if (farm) openSubModal(farm);
});

$('subForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('subFarmId').value;
  const body = {
    plan: $('subPlan').value || 'Custom Plan',
    durationDays: Number($('subDuration').value) || 1,
  };
  const btn = $('saveSub');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await renewFarm(id, body);
    closeSubModal();
    toast('Subscription renewed.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm';
  }
});

document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSubModal());

loadPlans();
