// Public landing page: no admin links, no secrets — Firebase's public web
// config (in firebase-config.js) is safe to ship; security comes from
// Firestore rules, not from hiding this config.
import { createEnquiry } from './db.js';

document.getElementById('year').textContent = new Date().getFullYear();

const form = document.getElementById('enquiryForm');
const statusBox = document.getElementById('enquiryStatus');
const submitBtn = document.getElementById('enquirySubmit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusBox.textContent = '';
  statusBox.classList.remove('success');

  // Honeypot — a filled-in hidden field means it's a bot, not a visitor.
  if (document.getElementById('enqCompany').value) return;

  const name = document.getElementById('enqName').value.trim();
  const email = document.getElementById('enqEmail').value.trim();
  const phone = document.getElementById('enqPhone').value.trim();
  const subject = document.getElementById('enqSubject').value.trim();
  const message = document.getElementById('enqMessage').value.trim();

  if (!name || !email || !subject || !message) {
    statusBox.textContent = 'Please fill in your name, email, subject and message.';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';
  try {
    await createEnquiry({ name, email, phone, subject, message });
    form.reset();
    statusBox.classList.add('success');
    statusBox.textContent = '✓ Your enquiry has been submitted successfully. Our team will review your message.';
  } catch (err) {
    console.error(err);
    statusBox.textContent = 'Something went wrong sending your enquiry. Please try again or call us instead.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send Enquiry';
  }
});
