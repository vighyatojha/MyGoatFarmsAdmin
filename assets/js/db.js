import { db, functions } from './firebase-config.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-functions.js';
import {
  collection, collectionGroup, doc, getDoc, getDocs, addDoc, setDoc, writeBatch, onSnapshot, query, where,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const nowIso = () => new Date().toISOString();

function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, removeUndefined(v)])
    );
  }
  return value;
}

/* ==============================================================
   FARMS
   Farm documents are created by the Flutter app itself (tied to
   authUid + a sequential FRM### id from counters/farms) — the admin
   panel never creates or deletes one. Every admin-managed value is
   kept in a single field, `subscriptionInfo`, which Firestore rules
   restrict admin writes to (see firestore.rules) so nothing here can
   ever touch farmName, ownerName, goats, stock, bills, etc.
   ============================================================== */

const farmsCol = collection(db, 'farms');
const subscriptionPaymentsCol = collection(db, 'subscriptionPayments');

function toPublicFarm(snap) {
  const d = snap.data();
  const info = d.subscriptionInfo || {};
  const now = Date.now();
  const expiryDate = info.expiryDate || null;
  const blocked = !!(info.blocked && info.blocked.blocked);

  // Raw stored status is Pending / Active / Rejected. Blocked / Expired
  // are derived so subscriptionInfo never has to be overwritten to show them.
  let displayStatus = info.status || 'Pending';
  if (blocked) displayStatus = 'Blocked';
  else if (displayStatus === 'Active' && expiryDate && expiryDate < now) displayStatus = 'Expired';

  const daysLeft = expiryDate ? Math.ceil((expiryDate - now) / DAY_MS) : null;

  return {
    id: snap.id,
    farmName: d.farmName || '',
    ownerName: d.ownerName || '',
    mobileNumber: d.mobileNumber || '',
    email: d.email || '',
    address: d.address || '',
    authUid: d.authUid || '',
    status: displayStatus,
    rawStatus: info.status || 'Pending',
    subscription: info.plan ? { plan: info.plan, durationDays: info.durationDays, amount: info.amount } : null,
    payment: info.paymentStatus ? { status: info.paymentStatus, date: info.paymentDate, reference: info.paymentReference } : null,
    approvalDate: info.approvalDate || null,
    startDate: info.startDate || null,
    expiryDate: info.expiryDate || null,
    daysLeft,
    blocked: {
      blocked,
      reason: info.blocked?.reason || '',
      blockedAt: info.blocked?.blockedAt || null,
      blockedBy: info.blocked?.blockedBy || '',
    },
    rejection: info.rejection || null,
    approvedBy: info.approvedBy || '',
  };
}

export async function listFarms() {
  const snap = await getDocs(farmsCol);
  return snap.docs.map(toPublicFarm).sort((a, b) => (b.farmName || '').localeCompare(a.farmName || ''));
}

// Live version of listFarms(): calls onChange with the current farm list
// immediately, then again every time any farm document changes (including
// this admin's own writes, via Firestore's local-cache echo — so an
// approve/reject/block/renew shows up without a manual reload). Returns an
// unsubscribe function; onError is optional and only fires on a genuine
// read failure (e.g. permission denied), not on empty results.
export function watchFarms(onChange, onError) {
  return onSnapshot(
    farmsCol,
    (snap) => onChange(snap.docs.map(toPublicFarm).sort((a, b) => (b.farmName || '').localeCompare(a.farmName || ''))),
    onError
  );
}

export async function getFarmOperationalStats(farmId) {
  // Match the Flutter app's real Firestore structure exactly:
  //   farms/{farmId}/partners/{partnerId}
  //   farms/{farmId}/palaiCustomers/{customerId}/goats/{goatId}
  //   farms/{farmId}/tradingGoats/{goatId}
  //
  // Palai goats are intentionally read through each customer instead of a
  // collection-group query. This mirrors FirestoreService.allActiveGoatsStream
  // while avoiding a dependency on a collection-group index/rule mismatch.

  const partnersPromise = getDocs(
    collection(db, 'farms', farmId, 'partners')
  );

  const customersPromise = getDocs(
    collection(db, 'farms', farmId, 'palaiCustomers')
  );

  const tradingPromise = getDocs(
    collection(db, 'farms', farmId, 'tradingGoats')
  );

  const [partnerSnap, customerSnap, tradingSnap] = await Promise.all([
    partnersPromise,
    customersPromise,
    tradingPromise,
  ]);

  const partnerDocs = partnerSnap.docs.filter((snap) => {
    const data = snap.data() || {};
    const status = String(data.status || 'active').toLowerCase();
    return status !== 'rejected' && status !== 'disabled';
  });

  let palaiGoats = 0;

  // The Flutter app stores Customer-Palai goats at:
  // farms/{farmId}/palaiCustomers/{customerId}/goats
  await Promise.all(
    customerSnap.docs.map(async (customerDoc) => {
      const goatsSnap = await getDocs(
        query(
          collection(
            db,
            'farms',
            farmId,
            'palaiCustomers',
            customerDoc.id,
            'goats'
          ),
          where('isCheckedOut', '==', false)
        )
      );
      palaiGoats += goatsSnap.size;
    })
  );

  return {
    partners: partnerDocs.length,
    palaiGoats,
    tradingGoats: tradingSnap.size,
    totalGoats: palaiGoats + tradingSnap.size,
  };
}

export async function getAllFarmOperationalStats(farms) {
  const entries = await Promise.all(
    farms.map(async (farm) => {
      try {
        return [farm.id, await getFarmOperationalStats(farm.id)];
      } catch (error) {
        console.error('Farm operational stats failed for', farm.id, error);
        return [
          farm.id,
          {
            partners: 0,
            palaiGoats: 0,
            tradingGoats: 0,
            totalGoats: 0,
            error: true,
            errorMessage: error?.message || 'Unable to load operational data',
          },
        ];
      }
    })
  );

  return Object.fromEntries(entries);
}

export async function getFarm(id) {
  const snap = await getDoc(doc(db, 'farms', id));
  return snap.exists() ? toPublicFarm(snap) : null;
}

// Approve a pending farm: records the payment, starts the subscription
// countdown from the approval date (not registration/payment date), and
// activates the farm. Writes ONLY the subscriptionInfo field (per rules).
export async function approveFarm(id, { plan, durationDays, amount, paymentStatus, paymentDate, paymentReference }, adminEmail) {
  const ref = doc(db, 'farms', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;

  const now = new Date();
  const approvalDate = now.toISOString();
  const safeDurationDays = Number(durationDays) || 1;
  const expiryDate = now.getTime() + safeDurationDays * DAY_MS;
  const prevInfo = snap.data().subscriptionInfo || {};

  // The approval screen currently supplies plan + duration only.
  // Firestore rejects undefined field values, so preserve existing payment
  // values when present and otherwise use safe defaults.
  const safeAmount = Number.isFinite(Number(amount))
    ? Number(amount)
    : Number(prevInfo.amount) || 0;

  const safePaymentStatus =
    paymentStatus ?? prevInfo.paymentStatus ?? 'Pending';

  const safePaymentDate =
    paymentDate || prevInfo.paymentDate || approvalDate;

  const safePaymentReference =
    paymentReference || prevInfo.paymentReference || '';

  const info = removeUndefined({
    ...prevInfo,
    status: 'Active',
    plan: plan || prevInfo.plan || '',
    durationDays: safeDurationDays,
    amount: safeAmount,
    paymentStatus: safePaymentStatus,
    paymentDate: safePaymentDate,
    paymentReference: safePaymentReference,
    approvalDate,
    startDate: approvalDate,
    expiryDate,
    approvedBy: adminEmail || '',
    blocked: prevInfo.blocked || { blocked: false },
  });
  delete info.rejection;

  const paymentRecord = removeUndefined({
    farmId: id,
    farmName: snap.data().farmName || id,
    amount: safeAmount,
    plan: plan || prevInfo.plan || '',
    durationDays: safeDurationDays,
    date: safePaymentDate,
    status: safePaymentStatus,
    reference: safePaymentReference,
    type: 'new',
    createdAt: approvalDate,
  });

  const batch = writeBatch(db);
  batch.update(ref, { subscriptionInfo: info });
  batch.set(doc(subscriptionPaymentsCol), paymentRecord);
  await batch.commit();
  return getFarm(id);
}

export async function renewFarm(id, { plan, durationDays, amount, paymentStatus, paymentDate, paymentReference }, adminEmail) {
  const ref = doc(db, 'farms', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;

  const d = snap.data();
  const prevInfo = d.subscriptionInfo || {};

  const now = Date.now();
  const safeDurationDays = Number(durationDays) || Number(prevInfo.durationDays) || 1;
  const base =
    prevInfo.expiryDate && Number(prevInfo.expiryDate) > now
      ? Number(prevInfo.expiryDate)
      : now;
  const expiryDate = base + safeDurationDays * DAY_MS;
  const ts = nowIso();

  // Renewal forms may currently provide only plan + duration.
  // Firestore rejects undefined values, so never write undefined.
  const safePlan = plan || prevInfo.plan || '';

  const safeAmount = Number.isFinite(Number(amount))
    ? Number(amount)
    : Number(prevInfo.amount) || 0;

  const safePaymentStatus =
    paymentStatus ?? prevInfo.paymentStatus ?? 'Pending';

  const safePaymentDate =
    paymentDate || ts;

  const safePaymentReference =
    paymentReference || '';

  const info = removeUndefined({
    ...prevInfo,
    status: 'Active',
    plan: safePlan,
    durationDays: safeDurationDays,
    amount: safeAmount,
    paymentStatus: safePaymentStatus,
    paymentDate: safePaymentDate,
    paymentReference: safePaymentReference,
    renewalDate: ts,
    renewedBy: adminEmail || prevInfo.renewedBy || '',
    expiryDate,
  });

  const paymentRecord = removeUndefined({
    farmId: id,
    farmName: d.farmName || id,
    amount: safeAmount,
    plan: safePlan,
    durationDays: safeDurationDays,
    date: safePaymentDate,
    status: safePaymentStatus,
    reference: safePaymentReference,
    type: 'renewal',
    createdAt: ts,
  });

  const batch = writeBatch(db);

  batch.update(ref, {
    subscriptionInfo: info,
  });

  batch.set(doc(subscriptionPaymentsCol), paymentRecord);

  await batch.commit();

  return getFarm(id);
}

export async function deleteFarm(id) {
  const farmId = String(id || '').trim();
  if (!farmId) throw new Error('Farm ID is required.');

  const callable = httpsCallable(functions, 'deleteFarm');
  await callable({ farmId });

  return true;
}

export async function rejectFarm(id, reason, adminEmail) {
  const ref = doc(db, 'farms', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const ts = nowIso();
  const prevInfo = snap.data().subscriptionInfo || {};
  const info = { ...prevInfo, status: 'Rejected', rejection: { reason: reason || '', rejectedAt: ts, rejectedBy: adminEmail } };
  await setDoc(ref, { subscriptionInfo: info }, { merge: true });
  return getFarm(id);
}

export async function blockFarm(id, reason, adminEmail) {
  const ref = doc(db, 'farms', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const ts = nowIso();
  const prevInfo = snap.data().subscriptionInfo || {};
  const info = { ...prevInfo, blocked: { blocked: true, reason: reason || '', blockedAt: ts, blockedBy: adminEmail } };
  await setDoc(ref, { subscriptionInfo: info }, { merge: true });
  return getFarm(id);
}

export async function unblockFarm(id) {
  const ref = doc(db, 'farms', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const ts = nowIso();
  const prevInfo = snap.data().subscriptionInfo || {};
  const info = { ...prevInfo, blocked: { ...(prevInfo.blocked || {}), blocked: false, unblockedAt: ts } };
  await setDoc(ref, { subscriptionInfo: info }, { merge: true });
  return getFarm(id);
}

export async function bulkBlockFarms(ids, reason, adminEmail) {
  const ts = nowIso();
  // The old version did `await getDoc(ref)` inside a for-loop — one read per
  // id, in series, before any write started. Firing all the reads at once
  // with Promise.all() turns N sequential round-trips into 1 round-trip's
  // worth of wall-clock time (Firestore still runs them in parallel).
  const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, 'farms', id))));

  const batch = writeBatch(db);
  let count = 0;
  ids.forEach((id, i) => {
    const snap = snaps[i];
    if (!snap.exists()) return;
    const prevInfo = snap.data().subscriptionInfo || {};
    batch.update(doc(db, 'farms', id), { subscriptionInfo: { ...prevInfo, blocked: { blocked: true, reason: reason || '', blockedAt: ts, blockedBy: adminEmail } } });
    count += 1;
  });
  if (count) await batch.commit();
  return count;
}

/* ==============================================================
   SUBSCRIPTION PAYMENTS
   Deliberately a different top-level collection from the app's own
   farms/{farmId}/payments (customer/Palai billing).
   ============================================================== */

function toPublicPayment(snap) {
  const d = snap.data();
  return {
    id: snap.id,
    farmId: d.farmId || '',
    farmName: d.farmName || '',
    amount: Number(d.amount) || 0,
    plan: d.plan || '',
    durationDays: Number(d.durationDays) || 0,
    date: d.date || '',
    status: d.status || 'Pending',
    reference: d.reference || '',
    type: d.type || 'new',
    createdAt: d.createdAt || '',
  };
}

export async function listPayments() {
  const snap = await getDocs(subscriptionPaymentsCol);
  return snap.docs.map(toPublicPayment).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// Live version of listPayments() — see watchFarms() above for the pattern.
export function watchPayments(onChange, onError) {
  return onSnapshot(
    subscriptionPaymentsCol,
    (snap) => onChange(snap.docs.map(toPublicPayment).sort((a, b) => (b.date || '').localeCompare(a.date || ''))),
    onError
  );
}

// Pure: turns an already-fetched payment list into the numbers the Earnings
// page (and the Dashboard's revenue stat) need. Split out from
// earningsSummary() so a live payments feed (watchPayments) can recompute
// this on every update without an extra Firestore read each time.
export function summarizeEarnings(all) {
  const paid = all.filter((p) => p.status === 'Paid');

  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thisYear = String(now.getFullYear());

  const total = paid.reduce((n, p) => n + p.amount, 0);
  const thisMonth = paid.filter((p) => (p.date || '').startsWith(thisMonthKey)).reduce((n, p) => n + p.amount, 0);
  const thisYearTotal = paid.filter((p) => (p.date || '').startsWith(thisYear)).reduce((n, p) => n + p.amount, 0);

  const byPlan = {};
  for (const p of paid) byPlan[p.plan || 'Other'] = (byPlan[p.plan || 'Other'] || 0) + p.amount;

  const byMonth = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
    const amount = paid.filter((p) => (p.date || '').startsWith(key)).reduce((n, p) => n + p.amount, 0);
    byMonth.push({ key, label, amount });
  }

  return { total, thisMonth, thisYear: thisYearTotal, paymentCount: paid.length, byPlan, byMonth };
}

// Aggregates the numbers the Earnings page needs, computed from payment
// records rather than any manually entered figure. One-time snapshot — see
// watchPayments() + summarizeEarnings() for the live equivalent.
export async function earningsSummary() {
  return summarizeEarnings(await listPayments());
}

/* ==============================================================
   ENQUIRIES — public Contact form inbox
   ============================================================== */

const enquiriesCol = collection(db, 'enquiries');

function toPublicEnquiry(snap) {
  const d = snap.data();
  return {
    id: snap.id,
    name: d.name || '',
    email: d.email || '',
    phone: d.phone || '',
    subject: d.subject || '',
    message: d.message || '',
    status: d.status || 'New',
    receivedAt: d.receivedAt || '',
  };
}

export async function listEnquiries() {
  const snap = await getDocs(enquiriesCol);
  return snap.docs.map(toPublicEnquiry).sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
}

// Live version of listEnquiries() — see watchFarms() above for the pattern.
// This is what makes a new visitor Contact-form submission show up in the
// Enquiry Inbox / Dashboard without anyone reloading the page.
export function watchEnquiries(onChange, onError) {
  return onSnapshot(
    enquiriesCol,
    (snap) => onChange(snap.docs.map(toPublicEnquiry).sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''))),
    onError
  );
}

// Public: called from the website's Contact form. Visitor -> Admin only,
// there is no reply/chat channel back to the visitor from here. The
// document shape here must exactly match what firestore.rules validates.
export async function createEnquiry({ name, email, phone, subject, message }) {
  await addDoc(enquiriesCol, { name, email, phone: phone || '', subject, message, status: 'New', receivedAt: nowIso() });
}

export async function markEnquiriesRead(ids) {
  const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, 'enquiries', id))));
  const batch = writeBatch(db);
  let count = 0;
  ids.forEach((id, i) => {
    if (!snaps[i].exists()) return;
    batch.update(doc(db, 'enquiries', id), { status: 'Read' });
    count += 1;
  });
  if (count) await batch.commit();
  return count;
}

export async function deleteEnquiries(ids) {
  const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, 'enquiries', id))));
  const batch = writeBatch(db);
  let count = 0;
  ids.forEach((id, i) => {
    if (!snaps[i].exists()) return;
    batch.delete(doc(db, 'enquiries', id));
    count += 1;
  });
  if (count) await batch.commit();
  return count;
}

/* ==============================================================
   ADMIN SETTINGS — subscription plans
   ============================================================== */

const plansRef = doc(db, 'adminSettings', 'subscriptionPlans');

const DEFAULT_PLANS = [
  { id: 'plan-1y', name: '1 Year', amount: 12000, days: 365 },
  { id: 'plan-6m', name: '6 Months', amount: 7000, days: 180 },
];

export async function getAdminContact() {
  const snap = await getDoc(doc(db, 'config', 'adminContact'));
  return snap.exists()
    ? snap.data()
    : { name: 'My Goat Farms Support', email: 'mygoatfarm20@gmail.com', phone: '' };
}

export async function saveAdminContact({ name, email, phone }) {
  const safe = removeUndefined({
    name: String(name || '').trim(),
    email: String(email || '').trim(),
    phone: String(phone || '').trim(),
    updatedAt: nowIso(),
  });

  await setDoc(doc(db, 'config', 'adminContact'), safe);
  return safe;
}

export async function getPlans() {
  const snap = await getDoc(plansRef);
  if (!snap.exists() || !Array.isArray(snap.data().plans) || !snap.data().plans.length) return DEFAULT_PLANS;
  return snap.data().plans;
}

export async function savePlans(plans) {
  await setDoc(plansRef, { plans, updatedAt: nowIso() });
  return plans;
}
