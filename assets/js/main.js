// Public landing page. Firebase's web config is public by design; security
// comes from Firestore rules, which re-check every field validated here.
import { createEnquiry } from './db.js';
import { bindForm, schemas, LIMITS } from './validators.js';

const $ = (id) => document.getElementById(id);
$('year').textContent = new Date().getFullYear();

// Header: hairline once the page scrolls, and the phone menu.
const header = $('top');
const menuBtn = $('menuToggle');
if (header) {
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}
if (header && menuBtn) {
  const setMenu = (open) => {
    header.classList.toggle('menu-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  menuBtn.addEventListener('click', () => setMenu(!header.classList.contains('menu-open')));
  $('siteNav').addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  document.addEventListener('click', (e) => { if (!header.contains(e.target)) setMenu(false); });
}

const form = $('enquiryForm');
const statusBox = $('enquiryStatus');
const submitBtn = $('enquirySubmit');
const counter = $('enqMessageCount');

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

const SEND_TIMEOUT_MS = 15000;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusBox.textContent = '';
  statusBox.classList.remove('success');

  if (!validator.validate()) {
    statusBox.textContent = 'Fix the highlighted fields, then send again.';
    return;
  }

  // Honeypot: a bot filled the hidden field. Look successful, store nothing.
  if ($('enqCompany').value) {
    form.reset();
    validator.reset();
    updateCounter();
    statusBox.classList.add('success');
    statusBox.textContent = 'Thanks — your enquiry was sent. We will get back to you soon.';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';
  try {
    // Offline, Firestore would wait forever for the server; give up after 15s.
    await Promise.race([
      createEnquiry(validator.values()),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), SEND_TIMEOUT_MS)),
    ]);
    form.reset();
    validator.reset();
    updateCounter();
    statusBox.classList.add('success');
    statusBox.textContent = 'Thanks — your enquiry was sent. We will get back to you soon.';
  } catch (err) {
    console.error(err);
    if (err.fields) validator.showErrors(err.fields);
    statusBox.textContent = err.code === 'timeout'
      ? "Couldn't reach the server. Check your internet connection and send again, or call us."
      : err.fields ? 'Fix the highlighted fields, then send again.' : "Your enquiry wasn't sent. Try again, or call us on 63540 81563.";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send Enquiry';
  }
});
