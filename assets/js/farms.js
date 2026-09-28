import { initAdminShell, toast, esc, fmtDate } from './admin-shell.js';
// Cache-bust the Firestore service so admin browsers do not keep an older
// approve/renew implementation after a deployment.
import { watchFarms, getAllFarmOperationalStats, approveFarm, renewFarm, rejectFarm, blockFarm, unblockFarm, deleteFarm, getPlans } from './db.js?v=20260928-5';

const adminUserPromise = initAdminShell({ active: 'farms', title: 'Farms', subtitle: 'Farm operations and subscription management.' });
const $ = (id) => document.getElementById(id);
let farms = [];
let stats = {};
let plans = [];
let activeFilter = 'All';
let searchTerm = '';
const FILTERS = ['All', 'Pending', 'Active', 'Expired', 'Blocked', 'Rejected'];

function initials(name) { return (name || 'Farm').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase(); }
function statusClass(status) { return String(status || '').replace(/\s+/g, ''); }

function renderFilters() {
  $('statusPills').innerHTML = FILTERS.map((f) => {
    const count = f === 'All' ? farms.length : farms.filter((x) => x.status === f).length;
    return '<button type="button" class="farm-filter' + (f === activeFilter ? ' active' : '') + '" data-filter="' + f + '">' + f + ' <b>' + count + '</b></button>';
  }).join('');
}

function actionButtons(f) {
  const buttons = ['<button class="farm-action view" type="button" data-action="view" data-id="' + esc(f.id) + '">View</button>'];
  if (f.status === 'Pending') {
    buttons.push('<button class="farm-action renew" type="button" data-action="approve" data-id="' + esc(f.id) + '">✓ Approve</button>');
    buttons.push('<button class="farm-action reject" type="button" data-action="reject" data-id="' + esc(f.id) + '">Reject</button>');
  } else if (f.status === 'Active' || f.status === 'Expired') {
    buttons.push('<button class="farm-action renew" type="button" data-action="renew" data-id="' + esc(f.id) + '">Renew</button>');
    buttons.push('<button class="farm-action reject" type="button" data-action="block" data-id="' + esc(f.id) + '">Block</button>');
  } else if (f.status === 'Blocked') {
    buttons.push('<button class="farm-action renew" type="button" data-action="unblock" data-id="' + esc(f.id) + '">Unblock</button>');
  }
  buttons.push('<button class="farm-action reject" type="button" data-action="delete" data-id="' + esc(f.id) + '">Delete</button>');
  return buttons.join('');
}

function farmCard(f) {
  const s = stats[f.id] || { partners: 0, palaiGoats: 0, tradingGoats: 0, totalGoats: 0 };
  const plan = f.subscription?.plan || 'NEW REGISTER';
  const duration = f.subscription?.durationDays ? Math.round(f.subscription.durationDays / 30) + ' mo' : '';
  const expiry = f.daysLeft != null ? Math.max(f.daysLeft, 0) + ' days left' : 'No subscription yet';
  const status = f.status || 'Pending';
  const partnerLabel = s.error ? '—' : s.partners;
  const palaiLabel = s.error ? '—' : s.palaiGoats;
  const tradingLabel = s.error ? '—' : s.tradingGoats;
  const totalLabel = s.error ? '—' : s.totalGoats;
  return '<article class="farm-card">' +
    '<div class="farm-card-head"><div><div class="farm-name-row"><h2>' + esc(f.farmName) + '</h2><span class="farm-status ' + statusClass(status) + '"><i></i>' + esc(status) + '</span></div>' +
    '<div class="farm-plan"><span>' + esc(f.id) + '</span><b>' + esc(plan) + '</b></div></div></div>' +
    '<div class="farm-meta"><span>◉ ' + esc(f.ownerName || '—') + ' · ' + esc(f.mobileNumber || '—') + '</span><span>◷ ' + esc(duration ? duration + ' · ' : '') + esc(expiry) + '</span></div>' +
    '<div class="farm-stats"><div><strong>' + partnerLabel + '</strong><small>Partners</small></div><div><strong>' + palaiLabel + '</strong><small>Palai goats</small></div><div><strong>' + tradingLabel + '</strong><small>Trading goats</small></div></div>' +
    '<div class="farm-total-line"><span>Total goats</span><strong>' + totalLabel + '</strong></div>' +
    '<div class="farm-card-actions">' + actionButtons(f) + '</div></article>';
}

function render() {
  const q = searchTerm.trim().toLowerCase();
  const rows = farms.filter((f) => {
    const statusMatch = activeFilter === 'All' || f.status === activeFilter;
    const searchMatch = [f.farmName, f.ownerName, f.mobileNumber, f.address, f.id, f.email].join(' ').toLowerCase().includes(q);
    return statusMatch && searchMatch;
  });
  $('farmCards').innerHTML = rows.map(farmCard).join('') || '<div class="farms-empty"><strong>No farms found</strong><span>Try another search or filter.</span></div>';
  $('totalUnits').textContent = farms.length + ' Total Unit' + (farms.length === 1 ? '' : 's');
  const statValues = Object.values(stats);
  const statsHaveErrors = statValues.some((x) => x.error);
  $('sumGoats').textContent = statsHaveErrors ? '—' : statValues.reduce((n, x) => n + (x.totalGoats || 0), 0);
  $('sumPartners').textContent = statsHaveErrors ? '—' : statValues.reduce((n, x) => n + (x.partners || 0), 0);
  const activeWithExpiry = farms.filter((f) => f.status === 'Active' && f.expiryDate);
  const healthy = activeWithExpiry.filter((f) => (f.daysLeft ?? 0) > 30).length;
  $('sumHealthy').textContent = activeWithExpiry.length ? Math.round((healthy / activeWithExpiry.length) * 100) + '%' : '—';
  renderFilters();
}

async function refreshStats(showToast = false) {
  $('syncStatus').textContent = 'Syncing…';
  try { stats = await getAllFarmOperationalStats(farms); const failed = Object.values(stats).some((x) => x.error); $('syncStatus').textContent = failed ? 'Some counts unavailable' : 'Synced just now'; render(); if (showToast) toast(failed ? 'Some counts could not load. Check Firestore rules.' : 'Farm counts refreshed.', failed); }
  catch (err) { $('syncStatus').textContent = 'Sync unavailable'; if (showToast) toast(err.message, true); }
}

watchFarms(async (list) => { farms = list; render(); await refreshStats(false); }, (err) => { $('syncStatus').textContent = 'Sync failed'; toast(err.message, true); });

function openSubModal(f, mode) {
  $('subModalTitle').textContent = mode === 'approve' ? 'Approve Farm' : 'Renew Subscription';
  $('subNote').textContent = mode === 'approve' ? 'Choose the subscription plan and duration.' : 'Renewing extends the current subscription expiry.';
  $('subFarmId').value = f.id; $('subFarmId').dataset.mode = mode;
  const firstPlan = plans[0]; $('subPlan').value = f.subscription?.plan || firstPlan?.name || ''; $('subDuration').value = f.subscription?.durationDays || firstPlan?.days || 365;
  $('subModal').classList.remove('hidden');
}
function closeSubModal() { $('subModal').classList.add('hidden'); }
$('closeSubModal').addEventListener('click', closeSubModal); $('cancelSubModal').addEventListener('click', closeSubModal);
$('subPlan').addEventListener('change', (e) => { const opt = e.target.selectedOptions[0]; if (opt?.dataset.days) $('subDuration').value = opt.dataset.days; });
$('subForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const id = $('subFarmId').value; const mode = $('subFarmId').dataset.mode;
  const body = {
    plan: $('subPlan').value || 'Custom Plan',
    durationDays: Number($('subDuration').value) || 1,
    amount: Number($('subAmount').value) || 0,
    paymentStatus: $('subPaymentStatus').value || 'Pending',
    paymentDate: $('subPaymentDate').value || '',
    paymentReference: $('subPaymentRef').value.trim(),
  };
  const btn = $('saveSub'); btn.disabled = true; btn.textContent = 'Saving…';
  try { if (mode === 'approve') await approveFarm(id, body, (await adminUserPromise).email); else await renewFarm(id, body); closeSubModal(); toast(mode === 'approve' ? 'Farm approved and activated.' : 'Subscription renewed.'); }
  catch (err) { toast(err.message, true); } finally { btn.disabled = false; btn.textContent = 'Confirm'; }
});

function openReasonModal(f, action) { $('reasonModalTitle').textContent = action === 'reject' ? 'Reject Farm' : 'Block Farm'; $('reasonFarmId').value = f.id; $('reasonAction').value = action; $('reasonText').value = ''; $('confirmReason').textContent = action === 'reject' ? 'Reject Farm' : 'Confirm Block'; $('reasonModal').classList.remove('hidden'); }
function closeReasonModal() { $('reasonModal').classList.add('hidden'); }
$('closeReasonModal').addEventListener('click', closeReasonModal); $('cancelReasonModal').addEventListener('click', closeReasonModal);
$('reasonForm').addEventListener('submit', async (e) => { e.preventDefault(); const id = $('reasonFarmId').value; const action = $('reasonAction').value; try { if (action === 'reject') await rejectFarm(id, $('reasonText').value.trim(), (await adminUserPromise).email); else await blockFarm(id, $('reasonText').value.trim(), (await adminUserPromise).email); closeReasonModal(); toast(action === 'reject' ? 'Farm rejected.' : 'Farm blocked.'); } catch (err) { toast(err.message, true); } });

function openViewModal(f) {
  const s = stats[f.id] || { partners: 0, palaiGoats: 0, tradingGoats: 0, totalGoats: 0 };
  $('viewModalTitle').textContent = f.farmName; $('viewAvatar').textContent = initials(f.farmName);
  $('viewStatus').innerHTML = '<span class="farm-status ' + statusClass(f.status) + '"><i></i>' + esc(f.status) + '</span>';
  const countValue = (value) => s.error ? 'Unavailable' : value;
  const rows = [['Farm ID',f.id],['Owner',f.ownerName],['Mobile',f.mobileNumber],['Email',f.email || '—'],['Partners',countValue(s.partners)],['Palai goats',countValue(s.palaiGoats)],['Trading goats',countValue(s.tradingGoats)],['Total goats',countValue(s.totalGoats)],['Plan',f.subscription?.plan || 'No subscription'],['Subscription start',fmtDate(f.startDate)],['Subscription expiry',fmtDate(f.expiryDate)],['Days left',f.daysLeft != null ? f.daysLeft : '—'],['Address',f.address || '—']];
  $('viewBody').innerHTML = rows.map(([label,value]) => '<div class="detail-item"><span>' + esc(label) + '</span><strong>' + esc(String(value)) + '</strong></div>').join('');
  $('viewModal').classList.remove('hidden');
}
$('closeViewModal').addEventListener('click', () => $('viewModal').classList.add('hidden'));
function setSearch(value) { searchTerm = value; $('search').value = value; $('searchMobile').value = value; render(); }
$('search').addEventListener('input', (e) => setSearch(e.target.value)); $('searchMobile').addEventListener('input', (e) => setSearch(e.target.value));
$('statusPills').addEventListener('click', (e) => { const btn = e.target.closest('button[data-filter]'); if (!btn) return; activeFilter = btn.dataset.filter; render(); });
async function refreshAll() { await refreshStats(true); }
$('refreshCounts').addEventListener('click', refreshAll); $('refreshCounts2').addEventListener('click', refreshAll);
$('farmCards').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]'); if (!btn) return; const farm = farms.find((f) => f.id === btn.dataset.id); if (!farm) return; const action = btn.dataset.action;
  if (action === 'view') return openViewModal(farm); if (action === 'approve') return openSubModal(farm, 'approve'); if (action === 'renew') return openSubModal(farm, 'renew'); if (action === 'reject') return openReasonModal(farm, 'reject'); if (action === 'block') return openReasonModal(farm, 'block');
  if (action === 'unblock') { try { await unblockFarm(farm.id); toast('Farm unblocked.'); } catch (err) { toast(err.message, true); } }
  if (action === 'delete') {
    const confirmed = window.confirm(
      'Delete "' + (farm.farmName || farm.id) + '" (' + farm.id + ')?\n\nThis permanently removes the farm and its stored farm data. This action cannot be undone.'
    );
    if (!confirmed) return;
    try {
      await deleteFarm(farm.id);
      toast('Farm deleted.');
    } catch (err) {
      toast(err?.message || 'Could not delete farm.', true);
    }
  }
});

$('exportCsv').addEventListener('click', () => {
  const rows = [['Farm ID','Farm','Owner','Mobile','Status','Partners','Palai Goats','Trading Goats','Total Goats','Plan','Expiry']];
  farms.forEach((f) => { const s = stats[f.id] || {}; rows.push([f.id,f.farmName,f.ownerName,f.mobileNumber,f.status,s.partners||0,s.palaiGoats||0,s.tradingGoats||0,s.totalGoats||0,f.subscription?.plan||'',f.expiryDate||'']); });
  const csv = rows.map((r) => r.map((v) => { const value = String(v ?? ''); return /[",\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value; }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'my-goat-farms-directory.csv'; a.click(); URL.revokeObjectURL(url);
});

async function loadPlans() { try { plans = await getPlans(); $('subPlan').innerHTML = plans.map((p) => '<option value="' + esc(p.name) + '" data-days="' + p.days + '">' + esc(p.name) + ' — ' + p.days + ' days</option>').join(''); } catch { plans = [{ name: '1 Year', days: 365 }]; $('subPlan').innerHTML = '<option value="1 Year" data-days="365">1 Year — 365 days</option>'; } }
loadPlans();
document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; [$('subModal'), $('reasonModal'), $('viewModal')].forEach((m) => m.classList.add('hidden')); });