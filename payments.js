import { initAdminShell, toast, esc, fmtDate, fmtMoney } from './admin-shell.js';
import { watchPayments } from './db.js';

// Not awaited: the shell paints immediately inside initAdminShell(), and the
// live payments subscription below starts in parallel with the admin check.
await initAdminShell({ active: 'payments', title: 'Payments', subtitle: 'Every payment recorded against a farm subscription.' });

const $ = (id) => document.getElementById(id);
let payments = [];
let activeFilter = 'All';
const FILTERS = ['All', 'Paid', 'Pending', 'Failed', 'Refunded'];

function renderPills() {
  $('statusPills').innerHTML = FILTERS.map((f) => {
    const count = f === 'All' ? payments.length : payments.filter((p) => p.status === f).length;
    return `<button type="button" class="pill${f === activeFilter ? ' active' : ''}" data-filter="${f}">${f} <span class="count">${count}</span></button>`;
  }).join('');
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const rows = payments.filter(
    (p) =>
      (activeFilter === 'All' || p.status === activeFilter) &&
      [p.farmName, p.plan, p.reference, p.farmId].join(' ').toLowerCase().includes(q)
  );

  $('paymentTable').innerHTML =
    rows
      .map(
        (p) => `
    <tr>
      <td class="cell-mono">${esc(p.id.slice(0, 8).toUpperCase())}</td>
      <td><div class="user-name">${esc(p.farmName)}</div><div class="cell-mono">${esc(p.farmId)}</div></td>
      <td>${esc(p.plan)}</td>
      <td class="cell-strong">${fmtMoney(p.amount)}</td>
      <td>${p.type === 'renewal' ? 'Renewal' : 'New'}</td>
      <td>${fmtDate(p.date)}</td>
      <td class="cell-mono">${esc(p.reference || '—')}</td>
      <td><span class="badge ${p.status}">${esc(p.status)}</span></td>
    </tr>`
      )
      .join('') || '<tr><td colspan="8" class="empty-row">No payment records yet.</td></tr>';

  $('statCount').textContent = payments.length;
  $('statPaid').textContent = payments.filter((p) => p.status === 'Paid').length;
  $('statPendingFailed').textContent = payments.filter((p) => p.status === 'Pending' || p.status === 'Failed').length;
  $('statAmount').textContent = fmtMoney(payments.filter((p) => p.status === 'Paid').reduce((n, p) => n + p.amount, 0));
  renderPills();
}

// Live subscription: new/updated payment records (e.g. from an approval or
// renewal on the Farms page) appear here automatically — no reload needed.
watchPayments(
  (list) => { payments = list; render(); },
  (err) => toast(err.message, true)
);

$('search').addEventListener('input', render);
$('statusPills').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  render();
});
