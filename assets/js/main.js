// Public website. Kept light: no Firebase on page load. The enquiry
// sender (Firestore Lite) is fetched only when the enquiry form opens.
import { bindForm, schemas, LIMITS } from './validators.js?v=20261007d';

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
document.documentElement.classList.add('js');
$('year').textContent = new Date().getFullYear();

/* ---------------- Header, menu, scroll progress ---------------- */

const header = $('top');
const menuBtn = $('menuToggle');
const progress = $('progress');
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const y = window.scrollY;
    header.classList.toggle('scrolled', y > 8);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
  });
}
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

const setMenu = (open) => {
  header.classList.toggle('menu-open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
};
menuBtn.addEventListener('click', () => setMenu(!header.classList.contains('menu-open')));
$('siteNav').addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('click', (e) => { if (!header.contains(e.target)) setMenu(false); });

/* ---------------- Reveal on scroll + journey line ---------------- */

if ('IntersectionObserver' in window && !reduceMotion) {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      io.unobserve(entry.target);
    }
  }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal, #journeyList').forEach((el) => io.observe(el));
} else {
  document.querySelectorAll('.reveal, #journeyList').forEach((el) => el.classList.add('in'));
}

/* ---------------- Count-up in the phone mock-up ---------------- */

function countUp(el) {
  const target = Number(el.dataset.count);
  const decimals = Number(el.dataset.decimals || 0);
  if (reduceMotion || !Number.isFinite(target)) return;
  const start = performance.now();
  const from = target * 0.84;
  const dur = 1400;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = (from + (target - from) * eased).toFixed(decimals);
    if (t < 1) requestAnimationFrame(step);
  };
  el.textContent = from.toFixed(decimals);
  setTimeout(() => requestAnimationFrame(step), 700);
}
document.querySelectorAll('[data-count]').forEach(countUp);

/* ---------------- Phone tilts gently with the pointer (desktop) ---------------- */

const visual = $('heroVisual');
const phone = $('phone');
if (visual && phone && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
  let frame = 0;
  visual.addEventListener('pointermove', (e) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const r = visual.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      phone.style.setProperty('--rx', `${(-y * 8).toFixed(2)}deg`);
      phone.style.setProperty('--ry', `${(x * 10).toFixed(2)}deg`);
    });
  });
  visual.addEventListener('pointerleave', () => {
    phone.style.setProperty('--rx', '0deg');
    phone.style.setProperty('--ry', '0deg');
  });
}

/* ---------------- Enquiry dialog ---------------- */

const dialog = $('enquiryDialog');
const panel = $('enquiryPanel');
const form = $('enquiryForm');
const sent = $('enquirySent');
const statusBox = $('enquiryStatus');
const submitBtn = $('enquirySubmit');
const counter = $('enqMessageCount');
let sender = null; // the lazily loaded enquiry-submit.js module
let lastTrigger = null;

const loadSender = () => (sender ||= import('./enquiry-submit.js?v=20261007d'));

// Warm the sender as soon as someone shows interest in contacting us.
document.querySelectorAll('[data-open-enquiry]').forEach((el) => {
  ['pointerenter', 'focus', 'touchstart'].forEach((ev) => el.addEventListener(ev, () => { loadSender().catch(() => {}); }, { once: true, passive: true }));
});

function openEnquiry(trigger) {
  lastTrigger = trigger || null;
  setMenu(false);
  loadSender().catch(() => {});
  // Grow from the button that was pressed.
  if (trigger) {
    const r = trigger.getBoundingClientRect();
    panel.style.setProperty('--ox', `${r.left + r.width / 2}px`);
    panel.style.setProperty('--oy', `${r.top + r.height / 2}px`);
  }
  dialog.classList.remove('closing');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  document.documentElement.classList.add('modal-open');
  setTimeout(() => (form.hidden ? $('sentTitle') : $('enqName')).focus({ preventScroll: true }), reduceMotion ? 0 : 260);
}

function closeEnquiry() {
  if (!dialog.open) return;
  const done = () => {
    dialog.classList.remove('closing');
    dialog.close();
    document.documentElement.classList.remove('modal-open');
    if (!sent.hidden) resetForm();
    lastTrigger?.focus({ preventScroll: true });
  };
  if (reduceMotion) { done(); return; }
  dialog.classList.add('closing');
  panel.addEventListener('animationend', done, { once: true });
  setTimeout(() => { if (dialog.open && dialog.classList.contains('closing')) done(); }, 400);
}

document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open-enquiry]');
  if (opener) { e.preventDefault(); openEnquiry(opener); return; }
  if (e.target.closest('[data-close-enquiry]')) closeEnquiry();
});
dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeEnquiry(); }); // Esc
dialog.addEventListener('click', (e) => { if (e.target === dialog) closeEnquiry(); }); // backdrop
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

// A shared link ending in #enquiry opens the form straight away.
if (location.hash === '#enquiry') openEnquiry(null);

/* ---------------- Form ---------------- */

const fields = {
  name: $('enqName'),
  email: $('enqEmail'),
  phone: $('enqPhone'),
  subject: $('enqSubject'),
  message: $('enqMessage'),
};
const validator = bindForm(fields, schemas.enquiry);

function updateCounter() {
  const n = fields.message.value.length;
  counter.textContent = `${n} / ${LIMITS.message}`;
  counter.classList.toggle('near-limit', n > LIMITS.message * 0.9);
}
fields.message.addEventListener('input', updateCounter);

$('subjectChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  fields.subject.value = chip.textContent.trim();
  fields.subject.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelectorAll('#subjectChips .chip').forEach((c) => c.classList.toggle('on', c === chip));
  fields.message.focus();
});

function resetForm() {
  form.reset();
  validator.reset();
  updateCounter();
  statusBox.textContent = '';
  document.querySelectorAll('#subjectChips .chip').forEach((c) => c.classList.remove('on'));
  form.hidden = false;
  sent.hidden = true;
  panel.classList.remove('is-sent');
}

function showSent(name) {
  $('sentText').textContent = `Thanks${name ? `, ${name.split(' ')[0]}` : ''}. We'll get back to you soon by phone or email.`;
  form.hidden = true;
  sent.hidden = false;
  panel.classList.add('is-sent');
  $('sentTitle').focus({ preventScroll: true });
}

function setBusy(on) {
  submitBtn.disabled = on;
  submitBtn.classList.toggle('busy', on);
  submitBtn.querySelector('.btn-label').textContent = on ? 'Sending…' : 'Send Enquiry';
}

const SEND_TIMEOUT_MS = 15000;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusBox.textContent = '';

  if (!validator.validate()) {
    statusBox.textContent = 'Fix the highlighted fields, then send again.';
    panel.classList.remove('shake');
    void panel.offsetWidth; // restart the animation
    panel.classList.add('shake');
    return;
  }

  const values = validator.values();

  // Honeypot: a bot filled the hidden field. Look successful, store nothing.
  if ($('enqCompany').value) { showSent(values.name); return; }

  setBusy(true);
  try {
    const { sendEnquiry } = await loadSender();
    await Promise.race([
      sendEnquiry(values),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), SEND_TIMEOUT_MS)),
    ]);
    showSent(values.name);
  } catch (err) {
    console.error(err);
    sender = null; // allow a fresh import if loading failed
    if (err.fields) validator.showErrors(err.fields);
    statusBox.textContent = err.code === 'timeout'
      ? "Couldn't reach the server. Check your internet connection and send again, or call us."
      : err.fields ? 'Fix the highlighted fields, then send again.' : "Your enquiry wasn't sent. Try again, or call us on 63540 81563.";
  } finally {
    setBusy(false);
  }
});
