import { db } from './firebase-config.js';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, writeBatch, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import { assertValid, schemas, normalizePhone, localDateKey, SUBSCRIPTION_STATUSES } from './validators.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 450; // Firestore allows 500 writes per batch
const nowIso = () => new Date().toISOString();
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : String(v));

function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, removeUndefined(v)])
    );
  }
  return value;
}

// Firestore Timestamp, ISO string, Date or millis → millis (or null).
function toMillis(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

// 'YYYY-MM-DD' strings are calendar dates in the admin's own time zone;
// full ISO timestamps are converted to the admin's local date. This keeps
// payments made between midnight and 05:30 IST on the right day/month.
export function localKeyOf(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = toMillis(v);
  return t == null ? '' : localDateKey(new Date(t));
}

/* ==============================================================
   FARMS
   Farm documents are created by the Flutter app (authUid + FRM### id).
   The admin panel never creates or deletes one: every admin-managed
   value lives in the single `subscriptionInfo` field, which the rules
   restrict admin writes to.
   ============================================================== */

const farmsCol = collection(db, 'farms');
const subscriptionPaymentsCol = collection(db, 'subscriptionPayments');
const byName = (a, b) => (a.farmName || a.id).localeCompare(b.farmName || b.id, 'en', { sensitivity: 'base' });

function toPublicFarm(snap) {
  const d = snap.data() || {};
  const info = d.subscriptionInfo && typeof d.subscriptionInfo === 'object' ? d.subscriptionInfo : {};
  const now = Date.now();
  const expiryDate = toMillis(info.expiryDate);
  const blocked = !!(info.blocked && info.blocked.blocked);

  // Stored status is Pending / Active / Rejected. Blocked and Expired are
  // derived so subscriptionInfo never has to be overwritten to show them.
  const rawStatus = str(info.status || d.status || 'Pending');
  let status = rawStatus;
  if (blocked) status = 'Blocked';
  else if (rawStatus === 'Active' && expiryDate && expiryDate < now) status = 'Expired';

  return {
    id: snap.id,
    farmName: str(d.farmName),
    ownerName: str(d.ownerName),
    mobileNumber: str(d.mobileNumber),
    email: str(d.email),
    address: str(d.address),
    authUid: str(d.authUid),
    createdAt: toMillis(d.createdAt),
    status,
    rawStatus,
    subscription: info.plan ? { plan: str(info.plan), durationDays: Number(info.durationDays) || 0, amount: Number(info.amount) || 0 } : null,
    payment: info.paymentStatus ? { status: str(info.paymentStatus), date: info.paymentDate, reference: str(info.paymentReference) } : null,
    approvalDate: toMillis(info.approvalDate),
    startDate: toMillis(info.startDate),
    renewalDate: toMillis(info.renewalDate),
    expiryDate,
    daysLeft: expiryDate ? Math.ceil((expiryDate - now) / DAY_MS) : null,
    blocked: {
      blocked,
      reason: str(info.blocked?.reason),
      blockedAt: toMillis(info.blocked?.blockedAt),
      blockedBy: str(info.blocked?.blockedBy),
    },
    rejection: info.rejection ? { reason: str(info.rejection.reason), rejectedAt: toMillis(info.rejection.rejectedAt), rejectedBy: str(info.rejection.rejectedBy) } : null,
    approvedBy: str(info.approvedBy),
    // Most recent thing that happened to this farm, for the activity feed.
    lastActivity: Math.max(
      toMillis(d.createdAt) || 0, toMillis(info.approvalDate) || 0, toMillis(info.renewalDate) || 0,
      toMillis(info.blocked?.blockedAt) || 0, toMillis(info.blocked?.unblockedAt) || 0, toMillis(info.rejection?.rejectedAt) || 0
    ) || null,
  };
}

export function watchFarms(onChange, onError) {
  return onSnapshot(farmsCol, (snap) => onChange(snap.docs.map(toPublicFarm).sort(byName)), onError);
}

export async function listFarms() {
  const snap = await getDocs(farmsCol);
  return snap.docs.map(toPublicFarm).sort(byName);
}

/* ---- Operational counts (partners / goats), read per farm on demand ---- */

export async function getFarmOperationalStats(farmId) {
  const sub = (...p) => collection(db, 'farms', farmId, ...p);
  const [partnerSnap, customerSnap, tradingSnap, ownSnap] = await Promise.all([
    getDocs(sub('partners')),
    getDocs(sub('palaiCustomers')),
    getDocs(sub('tradingGoats')),
    getDocs(sub('ownFarmGoats')).catch(() => null), // optional module
  ]);

  // Same rule as firestore.rules isPartner(): only 'active' partners (or
  // old partner docs with no status) have access to the farm.
  const partners = partnerSnap.docs.filter((s) => str(s.data()?.status || 'active').toLowerCase() === 'active').length;

  // Count goats that are not checked out. Goats saved before the
  // isCheckedOut field existed have no value at all; those still count.
  let palaiGoats = 0;
  await Promise.all(customerSnap.docs.map(async (c) => {
    const goats = await getDocs(sub('palaiCustomers', c.id, 'goats'));
    palaiGoats += goats.docs.filter((g) => g.data()?.isCheckedOut !== true).length;
  }));

  const ownGoats = ownSnap ? ownSnap.size : 0;
  return { partners, palaiGoats, tradingGoats: tradingSnap.size, ownGoats, totalGoats: palaiGoats + tradingSnap.size + ownGoats };
}

/** Loads counts for many farms, at most `concurrency` at a time. */
export async function loadFarmStats(farmIds, onEach, concurrency = 4) {
  let next = 0;
  const worker = async () => {
    while (next < farmIds.length) {
      const id = farmIds[next++];
      try { onEach(id, await getFarmOperationalStats(id)); }
      catch (error) { onEach(id, { error: true, errorMessage: error?.message || 'Counts unavailable' }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, farmIds.length) }, worker));
}

/* ---- Subscription actions — every one writes only subscriptionInfo ---- */

function cleanSubscriptionInput(input) {
  const body = {
    plan: str(input.plan).trim(),
    durationDays: String(input.durationDays ?? '').trim(),
    amount: String(input.amount ?? '').trim(),
    paymentStatus: str(input.paymentStatus),
    paymentDate: str(input.paymentDate).trim(),
    paymentReference: str(input.paymentReference).trim(),
  };
  assertValid(body, schemas.subscription);
  return { ...body, durationDays: Number(body.durationDays), amount: Number(body.amount) };
}

async function readFarm(id) {
  const ref = doc(db, 'farms', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw Object.assign(new Error(`Farm ${id} no longer exists.`), { code: 'not-found' });
  return { ref, snap, data: snap.data(), prevInfo: snap.data().subscriptionInfo || {} };
}

function paymentRecord(id, data, body, type, createdAt, adminEmail) {
  return removeUndefined({
    farmId: id,
    farmName: str(data.farmName) || id,
    amount: body.amount,
    plan: body.plan,
    durationDays: body.durationDays,
    date: body.paymentDate || localDateKey(new Date()),
    status: body.paymentStatus,
    reference: body.paymentReference,
    type,
    createdAt,
    recordedBy: adminEmail || '',
  });
}

// Approve a pending (or previously rejected) farm. The countdown starts on
// the approval date.
export async function approveFarm(id, input, adminEmail) {
  const body = cleanSubscriptionInput(input);
  const { ref, data, prevInfo } = await readFarm(id);
  const now = new Date();
  const ts = now.toISOString();

  const info = removeUndefined({
    ...prevInfo,
    status: 'Active',
    plan: body.plan,
    durationDays: body.durationDays,
    amount: body.amount,
    paymentStatus: body.paymentStatus,
    paymentDate: body.paymentDate || localDateKey(now),
    paymentReference: body.paymentReference,
    approvalDate: ts,
    startDate: ts,
    expiryDate: now.getTime() + body.durationDays * DAY_MS,
    approvedBy: adminEmail || '',
    blocked: prevInfo.blocked || { blocked: false },
  });
  delete info.rejection;

  const batch = writeBatch(db);
  batch.update(ref, { subscriptionInfo: info });
  batch.set(doc(subscriptionPaymentsCol), paymentRecord(id, data, body, 'new', ts, adminEmail));
  await batch.commit();
}

// Renew extends from the current expiry if it hasn't passed yet, otherwise
// from today. Blocked or rejected farms must be unblocked / approved first.
export async function renewFarm(id, input, adminEmail) {
  const body = cleanSubscriptionInput(input);
  const { ref, data, prevInfo } = await readFarm(id);
  if (prevInfo.blocked?.blocked) throw new Error('Unblock this farm before renewing it.');
  if (prevInfo.status !== 'Active') throw new Error('Only approved farms can be renewed. Approve it first.');

  const now = Date.now();
  const currentExpiry = toMillis(prevInfo.expiryDate);
  const base = currentExpiry && currentExpiry > now ? currentExpiry : now;
  const ts = nowIso();

  const info = removeUndefined({
    ...prevInfo,
    status: 'Active',
    plan: body.plan,
    durationDays: body.durationDays,
    amount: body.amount,
    paymentStatus: body.paymentStatus,
    paymentDate: body.paymentDate || localDateKey(new Date()),
    paymentReference: body.paymentReference,
    renewalDate: ts,
    renewedBy: adminEmail || '',
    expiryDate: base + body.durationDays * DAY_MS,
  });

  const batch = writeBatch(db);
  batch.update(ref, { subscriptionInfo: info });
  batch.set(doc(subscriptionPaymentsCol), paymentRecord(id, data, body, 'renewal', ts, adminEmail));
  await batch.commit();
}

export async function rejectFarm(id, reason, adminEmail) {
  assertValid({ reason }, schemas.reason);
  const { ref, prevInfo } = await readFarm(id);
  const info = { ...prevInfo, status: 'Rejected', rejection: { reason: reason.trim(), rejectedAt: nowIso(), rejectedBy: adminEmail || '' } };
  await setDoc(ref, { subscriptionInfo: info }, { merge: true });
}

export async function blockFarm(id, reason, adminEmail) {
  assertValid({ reason }, schemas.reason);
  const { ref, prevInfo } = await readFarm(id);
  const info = { ...prevInfo, blocked: { blocked: true, reason: reason.trim(), blockedAt: nowIso(), blockedBy: adminEmail || '' } };
  await setDoc(ref, { subscriptionInfo: info }, { merge: true });
}

export async function unblockFarm(id, adminEmail) {
  const { ref, prevInfo } = await readFarm(id);
  const info = { ...prevInfo, blocked: { ...(prevInfo.blocked || {}), blocked: false, unblockedAt: nowIso(), unblockedBy: adminEmail || '' } };
  await setDoc(ref, { subscriptionInfo: info }, { merge: true });
}

/* ==============================================================
   SUBSCRIPTION PAYMENTS (separate from the app's farms/{id}/payments)
   ============================================================== */

function toPublicPayment(snap) {
  const d = snap.data() || {};
  return {
    id: snap.id,
    farmId: str(d.farmId),
    farmName: str(d.farmName),
    amount: Number(d.amount) || 0,
    plan: str(d.plan),
    durationDays: Number(d.durationDays) || 0,
    date: d.date || '',
    dateKey: localKeyOf(d.date) || localKeyOf(d.createdAt),
    status: str(d.status || 'Pending'),
    reference: str(d.reference),
    type: str(d.type || 'new'),
    createdAt: toMillis(d.createdAt),
  };
}

const byDateDesc = (a, b) => (b.dateKey || '').localeCompare(a.dateKey || '') || (b.createdAt || 0) - (a.createdAt || 0);

export function watchPayments(onChange, onError) {
  return onSnapshot(subscriptionPaymentsCol, (snap) => onChange(snap.docs.map(toPublicPayment).sort(byDateDesc)), onError);
}

export async function listPayments() {
  const snap = await getDocs(subscriptionPaymentsCol);
  return snap.docs.map(toPublicPayment).sort(byDateDesc);
}

export async function setPaymentStatus(id, status) {
  if (!SUBSCRIPTION_STATUSES.includes(status)) throw new Error('Choose a valid payment status.');
  await setDoc(doc(db, 'subscriptionPayments', id), { status, statusUpdatedAt: nowIso() }, { merge: true });
}

export function summarizeEarnings(all) {
  const paid = all.filter((p) => p.status === 'Paid');
  const now = new Date();
  const monthKey = localDateKey(now).slice(0, 7);
  const yearKey = monthKey.slice(0, 4);
  const sum = (list) => list.reduce((n, p) => n + p.amount, 0);

  const byPlan = {};
  for (const p of paid) byPlan[p.plan || 'Other'] = (byPlan[p.plan || 'Other'] || 0) + p.amount;

  const byMonth = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = localDateKey(d).slice(0, 7);
    byMonth.push({
      key,
      label: d.toLocaleDateString('en-GB', { month: 'short' }),
      year: d.getFullYear(),
      amount: sum(paid.filter((p) => p.dateKey.startsWith(key))),
    });
  }

  return {
    total: sum(paid),
    thisMonth: sum(paid.filter((p) => p.dateKey.startsWith(monthKey))),
    thisYear: sum(paid.filter((p) => p.dateKey.startsWith(yearKey))),
    pendingAmount: sum(all.filter((p) => p.status === 'Pending')),
    paymentCount: paid.length,
    byPlan,
    byMonth,
  };
}

/* ==============================================================
   ENQUIRIES — public Contact form inbox
   ============================================================== */

const enquiriesCol = collection(db, 'enquiries');

function toPublicEnquiry(snap) {
  const d = snap.data() || {};
  return {
    id: snap.id,
    name: str(d.name),
    email: str(d.email),
    phone: str(d.phone),
    subject: str(d.subject),
    message: str(d.message),
    status: d.status === 'Read' ? 'Read' : 'New',
    receivedAt: toMillis(d.receivedAt),
  };
}

const byReceivedDesc = (a, b) => (b.receivedAt || 0) - (a.receivedAt || 0);

export function watchEnquiries(onChange, onError) {
  return onSnapshot(enquiriesCol, (snap) => onChange(snap.docs.map(toPublicEnquiry).sort(byReceivedDesc)), onError);
}

export async function listEnquiries() {
  const snap = await getDocs(enquiriesCol);
  return snap.docs.map(toPublicEnquiry).sort(byReceivedDesc);
}

// Public Contact form. Shape must match firestore.rules exactly.
export async function createEnquiry(input) {
  const body = {
    name: str(input.name).trim(),
    email: str(input.email).trim(),
    phone: str(input.phone).trim(),
    subject: str(input.subject).trim(),
    message: str(input.message).trim(),
  };
  assertValid(body, schemas.enquiry);
  await addDoc(enquiriesCol, {
    ...body,
    phone: body.phone ? normalizePhone(body.phone) : '',
    status: 'New',
    receivedAt: nowIso(),
  });
}

async function batchedWrite(ids, apply) {
  for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    ids.slice(i, i + BATCH_LIMIT).forEach((id) => apply(batch, id));
    await batch.commit();
  }
  return ids.length;
}

export const markEnquiriesRead = (ids) => batchedWrite(ids, (b, id) => b.update(doc(db, 'enquiries', id), { status: 'Read' }));
export const markEnquiriesNew = (ids) => batchedWrite(ids, (b, id) => b.update(doc(db, 'enquiries', id), { status: 'New' }));
export const deleteEnquiries = (ids) => batchedWrite(ids, (b, id) => b.delete(doc(db, 'enquiries', id)));

/* ==============================================================
   ADMIN SETTINGS
   ============================================================== */

const plansRef = doc(db, 'adminSettings', 'subscriptionPlans');
export const DEFAULT_PLANS = [
  { id: 'plan-1y', name: '1 Year', amount: 12000, days: 365 },
  { id: 'plan-6m', name: '6 Months', amount: 7000, days: 180 },
];
const DEFAULT_CONTACT = { name: 'My Goat Farms Support', email: 'mygoatfarm20@gmail.com', phone: '' };

export async function getPlans() {
  const snap = await getDoc(plansRef);
  const plans = snap.exists() ? snap.data().plans : null;
  if (!Array.isArray(plans) || !plans.length) return DEFAULT_PLANS.map((p) => ({ ...p }));
  return plans.map((p, i) => ({ id: str(p.id) || `plan-${i}`, name: str(p.name), amount: Number(p.amount) || 0, days: Number(p.days) || 1 }));
}

export async function savePlans(plans) {
  if (!Array.isArray(plans) || !plans.length) throw new Error('Add at least one plan.');
  if (plans.length > 20) throw new Error('Keep it to 20 plans or fewer.');
  const seen = new Set();
  const clean = plans.map((p) => {
    const body = { name: str(p.name).trim(), amount: String(p.amount ?? '').trim(), days: String(p.days ?? '').trim() };
    assertValid(body, schemas.plan);
    const key = body.name.toLowerCase();
    if (seen.has(key)) throw new Error(`Two plans are called "${body.name}". Give each plan its own name.`);
    seen.add(key);
    return { id: str(p.id) || `plan-${Date.now()}`, name: body.name, amount: Number(body.amount), days: Number(body.days) };
  });
  await setDoc(plansRef, { plans: clean, updatedAt: nowIso() });
  return clean;
}

export async function getAdminContact() {
  const snap = await getDoc(doc(db, 'config', 'adminContact'));
  return snap.exists() ? { ...DEFAULT_CONTACT, ...snap.data() } : { ...DEFAULT_CONTACT };
}

export async function saveAdminContact(input) {
  const body = { name: str(input.name).trim(), email: str(input.email).trim(), phone: str(input.phone).trim() };
  assertValid(body, schemas.contact);
  const safe = { ...body, phone: body.phone ? normalizePhone(body.phone) : '', updatedAt: nowIso() };
  await setDoc(doc(db, 'config', 'adminContact'), safe);
  return safe;
}

/* ==============================================================
   ADMIN CHECK
   ============================================================== */

export async function isAdminUid(uid) {
  const snap = await getDoc(doc(db, 'admins', uid));
  return snap.exists();
}

