// Sends a Contact-form enquiry from the public website.
//
// Loaded on demand (when the enquiry form opens), and uses Firestore Lite:
// a small REST-based build with no offline cache or live listeners, which
// is all a one-off form submission needs. This keeps the home page from
// downloading the full Firebase SDK on every visit.
//
// The document shape must match the `enquiries` rule in firestore.rules.
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js';
import { getFirestore, collection, addDoc } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore-lite.js';
import { firebaseConfig } from './firebase-options.js?v=20261007e';
import { assertValid, schemas, normalizePhone } from './validators.js?v=20261007e';

const app = getApps()[0] || initializeApp(firebaseConfig);
const db = getFirestore(app);

const str = (v) => (v == null ? '' : String(v));

export async function sendEnquiry(input) {
  const body = {
    name: str(input.name).trim(),
    email: str(input.email).trim(),
    phone: str(input.phone).trim(),
    subject: str(input.subject).trim(),
    message: str(input.message).trim(),
  };
  assertValid(body, schemas.enquiry);
  await addDoc(collection(db, 'enquiries'), {
    ...body,
    phone: body.phone ? normalizePhone(body.phone) : '',
    status: 'New',
    receivedAt: new Date().toISOString(),
  });
}
