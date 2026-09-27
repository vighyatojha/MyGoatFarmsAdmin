import { initAdminShell, toast, esc, fmtMoney } from './admin-shell.js';
import { watchPayments, summarizeEarnings } from './db.js';

// Not awaited: the shell paints immediately inside initAdminShell(), and the
// live payments subscription below starts in parallel with the admin check.
initAdminShell({ active: 'earnings', title: 'Earnings', subtitle: 'Revenue calculated from actual payment records.' });

function bars(items, max) {
  return items
    .map(
      (i) => `
    <div class="bar-row">
      <div class="bar-label">${esc(i.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${max ? Math.max(2, (i.amount / max) * 100) : 0}%"></div></div>
      <div class="bar-amount">${fmtMoney(i.amount)}</div>
    </div>`
    )
    .join('');
}

function render(data) {
  try {
    document.getElementById('statTotal').textContent = fmtMoney(data.total);
    document.getElementById('statMonth').textContent = fmtMoney(data.thisMonth);
    document.getElementById('statYear').textContent = fmtMoney(data.thisYear);
    document.getElementById('statCount').textContent = data.paymentCount;

    const monthMax = Math.max(1, ...data.byMonth.map((m) => m.amount));
    document.getElementById('monthBars').innerHTML =
      bars(data.byMonth, monthMax) || '<p class="empty-row">No revenue recorded yet.</p>';

    const planEntries = Object.entries(data.byPlan).map(([label, amount]) => ({ label, amount }));
    const planMax = Math.max(1, ...planEntries.map((p) => p.amount));
    document.getElementById('planBars').innerHTML =
      bars(planEntries, planMax) || '<p class="empty-row">No plan revenue recorded yet.</p>';
  } catch (err) {
    toast(err.message, true);
  }
}

// Live subscription: recomputes the summary from scratch on every payments
// change (a new approval/renewal payment) so the page never needs a reload.
watchPayments(
  (payments) => render(summarizeEarnings(payments)),
  (err) => toast(err.message, true)
);
