import { initAdminShell, esc, fmtDate, fmtMoney, toast } from './admin-shell.js';
import { watchFarms, watchEnquiries, watchPayments, summarizeEarnings } from './db.js';

// Not awaited: the shell paints immediately inside initAdminShell(), and the
// live subscriptions below start fetching this page's data right away too,
// in parallel with the admin check, instead of waiting for it first.
initAdminShell({ active: 'dashboard', title: 'Dashboard', subtitle: 'An overview of farms, subscriptions and enquiries.' });

// Each stream keeps its own latest snapshot; render() re-draws the whole
// dashboard from whichever streams have reported in so far, and runs again
// every time any one of them updates (a new farm, enquiry, or payment).
let farms = [];
let enquiries = [];
let payments = [];

function render() {
  const rev = summarizeEarnings(payments);

  document.getElementById('statPending').textContent = farms.filter((f) => f.status === 'Pending').length;
  document.getElementById('statActive').textContent = farms.filter((f) => f.status === 'Active').length;
  document.getElementById('statBlocked').textContent = farms.filter((f) => f.status === 'Blocked').length;
  document.getElementById('statRevenue').textContent = fmtMoney(rev.total);

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
watchPayments((list) => { payments = list; render(); }, (err) => toast(err.message, true));
