import { initAdminShell, toast, esc, fmtDate } from './admin-shell.js';
import { watchEnquiries, markEnquiriesRead, deleteEnquiries } from './db.js';

// Not awaited: the shell paints immediately inside initAdminShell(), and the
// live enquiries subscription below starts in parallel with the admin check.
initAdminShell({ active: 'enquiries', title: 'Enquiries', subtitle: 'Messages submitted through the public Contact form.' });

const $ = (id) => document.getElementById(id);
let enquiries = [];
let activeFilter = 'All';
let selectedId = null;
const selected = new Set();
const FILTERS = ['All', 'New', 'Read'];

function renderPills() {
  $('statusPills').innerHTML = FILTERS.map((f) => {
    const count = f === 'All' ? enquiries.length : enquiries.filter((e) => e.status === f).length;
    return `<button type="button" class="pill${f === activeFilter ? ' active' : ''}" data-filter="${f}">${f} <span class="count">${count}</span></button>`;
  }).join('');
}

function visibleRows() {
  const q = $('search').value.trim().toLowerCase();
  return enquiries.filter(
    (e) =>
      (activeFilter === 'All' || e.status === activeFilter) &&
      [e.name, e.email, e.subject].join(' ').toLowerCase().includes(q)
  );
}

function render() {
  const rows = visibleRows();

  $('enquiryList').innerHTML =
    rows
      .map(
        (e) => `
    <div class="inbox-item${e.id === selectedId ? ' active' : ''}${e.status === 'New' ? ' unread' : ''}" data-row="${esc(e.id)}">
      <input type="checkbox" class="row-check" data-id="${esc(e.id)}" ${selected.has(e.id) ? 'checked' : ''} aria-label="Select enquiry from ${esc(e.name)}">
      <div class="inbox-item-main" data-view="${esc(e.id)}">
        <div class="inbox-item-row1">
          <span class="inbox-item-name">${esc(e.name)}</span>
          <span class="badge ${e.status}">${esc(e.status)}</span>
        </div>
        <div class="inbox-item-subject">${esc(e.subject)}</div>
        <div class="inbox-item-row2">
          <span class="inbox-item-email">${esc(e.email)}</span>
          <span class="inbox-item-date">${fmtDate(e.receivedAt)}</span>
        </div>
      </div>
    </div>`
      )
      .join('') || '<div class="empty-row">No enquiries yet.</div>';

  $('statTotal').textContent = enquiries.length;
  $('statNew').textContent = enquiries.filter((e) => e.status === 'New').length;
  $('listCount').textContent = `${rows.length} enquir${rows.length === 1 ? 'y' : 'ies'}`;
  renderPills();
  renderSelectBar();
  renderDetail();
}

function renderSelectBar() {
  $('selectBar').classList.toggle('show', selected.size > 0);
  $('selectCount').textContent = `${selected.size} selected`;
  const boxes = document.querySelectorAll('.row-check');
  $('headCheck').checked = selected.size > 0 && selected.size === boxes.length;
}

function renderDetail() {
  const enquiry = enquiries.find((x) => x.id === selectedId);
  if (!enquiry) {
    $('detailEmpty').classList.remove('hidden');
    $('detailContent').classList.add('hidden');
    return;
  }
  $('detailEmpty').classList.add('hidden');
  $('detailContent').classList.remove('hidden');
  $('detailSubject').textContent = enquiry.subject;
  $('detailStatus').textContent = enquiry.status;
  $('detailStatus').className = `badge ${enquiry.status}`;
  $('detailMeta').innerHTML = [
    ['From', enquiry.name],
    ['Email', enquiry.email],
    ['Phone', enquiry.phone || '—'],
    ['Received', fmtDate(enquiry.receivedAt)],
  ]
    .map(([label, value]) => `<div class="detail-item"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`)
    .join('');
  $('detailMessage').textContent = enquiry.message;
}

async function selectEnquiry(id) {
  selectedId = id;
  renderDetail();
  const enquiry = enquiries.find((x) => x.id === id);
  if (enquiry && enquiry.status === 'New') {
    try {
      await markEnquiriesRead([id]);
    } catch { /* non-critical */ }
  }
}

// Live subscription: enquiries re-renders on its own whenever a document
// changes — a new visitor submission, or this admin's own mark-read/delete
// (Firestore echoes local writes back through the same listener) — so nothing
// after this needs to call load()/listEnquiries() again to "refresh".
watchEnquiries(
  (list) => { enquiries = list; render(); },
  (err) => toast(err.message, true)
);

$('search').addEventListener('input', render);
$('statusPills').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  render();
});

$('enquiryList').addEventListener('click', (e) => {
  if (e.target.classList.contains('row-check')) return;
  const item = e.target.closest('[data-view]');
  if (!item) return;
  selectEnquiry(item.dataset.view);
});

$('enquiryList').addEventListener('change', (e) => {
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

$('markReadBtn').addEventListener('click', async () => {
  if (!selected.size) return;
  try {
    await markEnquiriesRead([...selected]);
    toast(`${selected.size} enquiry(ies) marked read.`);
    selected.clear();
  } catch (err) {
    toast(err.message, true);
  }
});

$('deleteBtn').addEventListener('click', async () => {
  if (!selected.size) return;
  if (!confirm(`Delete ${selected.size} enquiry(ies)? This action cannot be undone.`)) return;
  try {
    await deleteEnquiries([...selected]);
    toast(`${selected.size} enquiry(ies) deleted.`);
    if (selected.has(selectedId)) selectedId = null;
    selected.clear();
  } catch (err) {
    toast(err.message, true);
  }
});