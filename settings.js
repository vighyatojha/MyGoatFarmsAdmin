import { initAdminShell, toast, esc } from './admin-shell.js';
import { getPlans, savePlans } from './db.js';

// Not awaited here on purpose: the shell paints immediately inside
// initAdminShell(), and load() below fetches the subscription plans right
// away too, in parallel with the admin check. accountEmail is filled in
// separately, once the check actually resolves.
const adminUser = await initAdminShell({ active: 'settings', title: 'Settings', subtitle: 'Manage subscription plans and your admin account.' });
document.getElementById('accountEmail').textContent = adminUser.email;

const $ = (id) => document.getElementById(id);
let plans = [];

function render() {
  $('planGrid').innerHTML = plans
    .map(
      (p, i) => `
    <div class="plan-card" data-index="${i}">
      <h3>Plan ${i + 1}</h3>
      <div class="field">
        <label class="field-label">Plan Name</label>
        <input class="input plan-name" value="${esc(p.name)}" placeholder="e.g. 1 Year">
      </div>
      <div class="field">
        <label class="field-label">Amount (₹)</label>
        <input class="input plan-amount" type="number" min="0" value="${p.amount}">
      </div>
      <div class="field">
        <label class="field-label">Duration (days)</label>
        <input class="input plan-days" type="number" min="1" value="${p.days}">
      </div>
      <div class="plan-card-actions">
        <button type="button" class="action-btn danger" data-remove="${i}">Remove</button>
      </div>
    </div>`
    )
    .join('') || '<p class="empty-row">No plans yet — add one to get started.</p>';
}

async function load() {
  try {
    plans = (await getPlans()).map((p) => ({ ...p }));
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

$('addPlan').addEventListener('click', () => {
  plans.push({ id: `plan-${Date.now()}`, name: '', amount: 0, days: 30 });
  render();
});

$('planGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  plans.splice(Number(btn.dataset.remove), 1);
  render();
});

$('savePlans').addEventListener('click', async () => {
  const cards = [...document.querySelectorAll('.plan-card')];
  const next = cards.map((card, i) => ({
    id: plans[i]?.id || `plan-${Date.now()}-${i}`,
    name: card.querySelector('.plan-name').value.trim(),
    amount: Number(card.querySelector('.plan-amount').value) || 0,
    days: Number(card.querySelector('.plan-days').value) || 1,
  }));

  if (!next.length) {
    toast('Add at least one subscription plan.', true);
    return;
  }
  if (next.some((p) => !p.name)) {
    toast('Every plan needs a name.', true);
    return;
  }

  const btn = $('savePlans');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    plans = await savePlans(next);
    render();
    toast('Subscription plans saved.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
});

load();
