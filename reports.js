import { initAdminShell, toast, esc, fmtDate } from './admin-shell.js';
import { listFarms, listPayments, listEnquiries } from './db.js';

// Not awaited: see dashboard.js/admin-shell.js — shell paints immediately,
// this page's data fetches in parallel with the admin check.
await initAdminShell({ active: 'reports', title: 'Reports', subtitle: 'Farm, subscription, payment and enquiry reports.' });

const $ = (id) => document.getElementById(id);

const REPORTS = {
  farm: {
    title: 'Farm Report',
    desc: 'All registered farms and their current subscription status.',
    fetch: listFarms,
    columns: [
      ['id', 'Farm ID'], ['farmName', 'Farm Name'], ['ownerName', 'Owner'], ['mobileNumber', 'Mobile'],
      ['email', 'Email'], ['address', 'Address'], ['status', 'Status'],
    ],
  },
  subscription: {
    title: 'Subscription Report',
    desc: 'Plan, dates and days left for every subscribed farm.',
    fetch: listFarms,
    dateField: 'startDate',
    filter: (f) => !!f.subscription,
    columns: [
      ['id', 'Farm ID'], ['farmName', 'Farm'], ['status', 'Status'],
      ['plan', 'Plan', (f) => f.subscription?.plan], ['startDate', 'Start', (f) => fmtDate(f.startDate)],
      ['expiryDate', 'Expiry', (f) => fmtDate(f.expiryDate)], ['daysLeft', 'Days Left'],
    ],
  },
  payment: {
    title: 'Payment Report',
    desc: 'Every payment recorded against a subscription.',
    fetch: listPayments,
    dateField: 'date',
    columns: [
      ['id', 'Payment ID'], ['farmName', 'Farm'], ['plan', 'Plan'], ['amount', 'Amount'],
      ['type', 'Type'], ['date', 'Date', (p) => fmtDate(p.date)], ['reference', 'Reference'], ['status', 'Status'],
    ],
  },
  revenue: {
    title: 'Revenue Report',
    desc: 'Paid payments only — the earnings figures.',
    fetch: listPayments,
    dateField: 'date',
    filter: (p) => p.status === 'Paid',
    columns: [
      ['id', 'Payment ID'], ['farmName', 'Farm'], ['plan', 'Plan'], ['amount', 'Amount'],
      ['date', 'Date', (p) => fmtDate(p.date)],
    ],
  },
  enquiry: {
    title: 'Enquiry Report',
    desc: 'All enquiries submitted through the Contact form.',
    fetch: listEnquiries,
    dateField: 'receivedAt',
    columns: [
      ['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['subject', 'Subject'],
      ['status', 'Status'], ['receivedAt', 'Received', (e) => fmtDate(e.receivedAt)],
    ],
  },
};

let active = null;

$('reportTiles').innerHTML = Object.entries(REPORTS)
  .map(([key, r]) => `<button type="button" class="report-tile" data-key="${key}"><h3>${esc(r.title)}</h3><p>${esc(r.desc)}</p></button>`)
  .join('');

$('reportTiles').addEventListener('click', (e) => {
  const tile = e.target.closest('.report-tile');
  if (!tile) return;
  active = tile.dataset.key;
  document.querySelectorAll('.report-tile').forEach((t) => t.classList.toggle('active', t === tile));
  $('generateBtn').disabled = false;
  $('previewHead').innerHTML = '';
  $('previewBody').innerHTML = '';
});

function toCsv(cols, data) {
  const header = cols.map(([, label]) => `"${label.replace(/"/g, '""')}"`).join(',');
  const lines = data.map((row) =>
    cols
      .map(([key, , fn]) => {
        const val = fn ? fn(row) : row[key];
        return `"${String(val ?? '').replace(/"/g, '""')}"`;
      })
      .join(',')
  );
  return [header, ...lines].join('\r\n');
}

function download(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$('generateBtn').addEventListener('click', async () => {
  if (!active) return;
  const cfg = REPORTS[active];
  const btn = $('generateBtn');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    let data = await cfg.fetch();
    if (cfg.filter) data = data.filter(cfg.filter);

    const from = $('dateFrom').value ? new Date($('dateFrom').value).getTime() : null;
    const to = $('dateTo').value ? new Date($('dateTo').value).getTime() + 86400000 : null;
    if (cfg.dateField && (from || to)) {
      data = data.filter((row) => {
        const t = new Date(row[cfg.dateField] || 0).getTime();
        return (!from || t >= from) && (!to || t <= to);
      });
    }

    $('previewHead').innerHTML = `<tr>${cfg.columns.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr>`;
    $('previewBody').innerHTML =
      data
        .slice(0, 25)
        .map((row) => `<tr>${cfg.columns.map(([key, , fn]) => `<td>${esc(fn ? fn(row) : row[key])}</td>`).join('')}</tr>`)
        .join('') || `<tr><td colspan="${cfg.columns.length}" class="empty-row">No records match this range.</td></tr>`;

    if (data.length) {
      download(`${active}-report-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(cfg.columns, data));
      toast(`${cfg.title} downloaded (${data.length} records). Showing first 25 below.`);
    } else {
      toast('No records match this report and date range.', true);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Report';
  }
});
