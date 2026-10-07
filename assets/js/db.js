import { db } from './firebase-config.js?v=20261007d';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, writeBatch, onSnapshot,
  query, where, getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import { assertValid, schemas, normalizePhone, check, rules, localDateKey } from './validators.js?v=20261007d';

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
    subscription: info.plan ? { plan: str(info.plan), durationDays: Number(info.durationDays) || 0 } : null,
    preferredLanguage: str(d.preferredLanguage || 'en'),
    updatedAt: toMillis(d.updatedAt),
    hasPhoto: !!d.profileImage,
    business: d.billSettings && typeof d.billSettings === 'object' ? {
      name: str(d.billSettings.businessName || d.billSettings.farmName || d.billSettings.name),
      phone: str(d.billSettings.phone || d.billSettings.mobileNumber),
      address: str(d.billSettings.address),
    } : null,
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
    renewedBy: str(info.renewedBy),
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

/* ---- Farm numbers (partners / goats) ----------------------------------
   Counts use Firestore count queries, which cost one read per 1,000
   documents instead of downloading every goat (goat docs carry photos). */

export const TRADING_STATUSES = ['Available', 'Own Palai', 'Booked', 'Wait on Delivery', 'In Customer Palai', 'Sold', 'Dead'];
const TRADING_GONE = ['Sold', 'Dead'];

const countOf = async (ref) => (await getCountFromServer(ref)).data().count;
const farmCol = (farmId, ...p) => collection(db, 'farms', farmId, ...p);
const isActivePartner = (data) => str(data?.status || 'active').toLowerCase() === 'active';

async function palaiCounts(farmId, customerId) {
  const goats = farmCol(farmId, 'palaiCustomers', customerId, 'goats');
  const [total, checkedOut] = await Promise.all([
    countOf(goats),
    countOf(query(goats, where('isCheckedOut', '==', true))),
  ]);
  return { total, checkedOut, active: Math.max(0, total - checkedOut) };
}

/** Light numbers for the farm list. */
export async function getFarmOperationalStats(farmId) {
  const trading = farmCol(farmId, 'tradingGoats');
  const [partnerSnap, customerSnap, tradingTotal, tradingGone, ownGoats] = await Promise.all([
    getDocs(farmCol(farmId, 'partners')),
    getDocs(farmCol(farmId, 'palaiCustomers')),
    countOf(trading),
    countOf(query(trading, where('currentStatus', 'in', TRADING_GONE))),
    countOf(farmCol(farmId, 'ownFarmGoats')).catch(() => 0),
  ]);
  const palai = await Promise.all(customerSnap.docs.map((c) => palaiCounts(farmId, c.id)));
  const palaiGoats = palai.reduce((n, p) => n + p.active, 0);
  const tradingGoats = Math.max(0, tradingTotal - tradingGone);
  return {
    partners: partnerSnap.docs.filter((p) => isActivePartner(p.data())).length,
    palaiCustomers: customerSnap.size,
    palaiGoats,
    tradingGoats,
    ownGoats,
    totalGoats: palaiGoats + tradingGoats + ownGoats,
  };
}

/** Loads counts for many farms, at most `concurrency` at a time. */
export async function loadFarmStats(farmIds, onEach, concurrency = 4) {
  let next = 0;
  const worker = async () => {
    while (next < farmIds.length) {
      const id = farmIds[next++];
      try { onEach(id, await getFarmOperationalStats(id)); }
      catch (error) { console.error('Farm counts failed for', id, error); onEach(id, { error: true, errorMessage: error?.message || 'Counts unavailable' }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, farmIds.length) }, worker));
}

const PERMISSION_GROUPS = {
  Palai: ['palaiView', 'palaiCreate', 'palaiUpdate', 'palaiDelete'],
  Customers: ['customersView', 'customersCreate', 'customersUpdate', 'customersDelete'],
  Stock: ['stockView', 'stockCreate', 'stockUpdate', 'stockDelete'],
  Trading: ['tradingView', 'tradingPurchaseCreate', 'tradingSell', 'tradingSupplierPayment', 'tradingReceive', 'tradingManageStock'],
  Finance: ['financeView', 'financeExpenseCreate', 'financeExpenseEdit', 'financeExpenseVoid', 'financeRevenueCreate', 'financeRevenueEdit', 'financeRevenueVoid', 'financeLedgerView', 'financeReportsView'],
  Reports: ['reportsView'],
  Profile: ['profileView'],
};

function partnerAccess(perms) {
  const p = perms && typeof perms === 'object' ? perms : {};
  return Object.entries(PERMISSION_GROUPS)
    .map(([group, keys]) => ({ group, granted: keys.filter((k) => p[k] === true).length, total: keys.length }))
    .filter((g) => g.granted > 0);
}

/** Everything the farm detail page shows. Read only when that page opens. */
export async function getFarmDetail(farmId) {
  const trading = farmCol(farmId, 'tradingGoats');
  const safe = (promise, fallback) => promise.catch((e) => { console.warn('Farm detail part failed', e); return fallback; });

  const [partnerSnap, customerSnap, stockSnap, tradingCounts, ownGoats, lots, sales] = await Promise.all([
    getDocs(farmCol(farmId, 'partners')),
    getDocs(farmCol(farmId, 'palaiCustomers')),
    safe(getDocs(farmCol(farmId, 'stockItems')), null),
    Promise.all([countOf(trading), ...TRADING_STATUSES.map((st) => countOf(query(trading, where('currentStatus', '==', st))))]),
    safe(countOf(farmCol(farmId, 'ownFarmGoats')), 0),
    safe(countOf(farmCol(farmId, 'tradingPurchases')), null),
    safe(countOf(farmCol(farmId, 'sales')), null),
  ]);

  const partners = partnerSnap.docs.map((d) => {
    const p = d.data() || {};
    return {
      id: d.id,
      name: str(p.name),
      mobileNumber: str(p.mobileNumber),
      email: str(p.email),
      status: str(p.status || 'active').toLowerCase(),
      createdAt: toMillis(p.createdAt),
      access: partnerAccess(p.permissions),
    };
  }).sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || a.name.localeCompare(b.name));

  const customers = await Promise.all(customerSnap.docs.map(async (d) => {
    const c = d.data() || {};
    const goats = await safe(palaiCounts(farmId, d.id), { total: 0, checkedOut: 0, active: 0 });
    return {
      id: d.id,
      name: str(c.name),
      mobileNumber: str(c.mobileNumber),
      address: str(c.address),
      package: str(c.package),
      joiningDate: toMillis(c.joiningDate),
      goats,
    };
  }));
  customers.sort((a, b) => b.goats.active - a.goats.active || a.name.localeCompare(b.name));

  const [tradingTotal, ...byStatus] = tradingCounts;
  const tradingByStatus = Object.fromEntries(TRADING_STATUSES.map((st, i) => [st, byStatus[i]]));
  const known = byStatus.reduce((n, x) => n + x, 0);
  if (tradingTotal > known) tradingByStatus.Other = tradingTotal - known;
  const tradingOnFarm = Math.max(0, tradingTotal - (tradingByStatus.Sold || 0) - (tradingByStatus.Dead || 0));

  const stock = stockSnap ? stockSnap.docs.map((d) => {
    const x = d.data() || {};
    const quantity = Number(x.quantity) || 0;
    const low = Number(x.lowStockThreshold) || 0;
    return { id: d.id, name: str(x.name), quantity, unit: str(x.unit || 'kg'), low: low > 0 && quantity <= low };
  }).sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name)) : null;

  const palaiActive = customers.reduce((n, c) => n + c.goats.active, 0);
  return {
    loadedAt: Date.now(),
    partners,
    customers,
    stock,
    trading: { total: tradingTotal, onFarm: tradingOnFarm, byStatus: tradingByStatus },
    palai: { active: palaiActive, checkedOut: customers.reduce((n, c) => n + c.goats.checkedOut, 0), customers: customers.length },
    ownGoats,
    lots,
    sales,
    totalGoats: palaiActive + tradingOnFarm + ownGoats,
  };
}

/* ---- Subscription actions — every one writes only subscriptionInfo ---- */

function cleanSubscriptionInput(input) {
  const body = { plan: str(input.plan).trim(), durationDays: String(input.durationDays ?? '').trim() };
  assertValid(body, schemas.subscription);
  return { ...body, durationDays: Number(body.durationDays) };
}

async function readFarm(id) {
  const ref = doc(db, 'farms', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw Object.assign(new Error(`Farm ${id} no longer exists.`), { code: 'not-found' });
  return { ref, snap, data: snap.data(), prevInfo: snap.data().subscriptionInfo || {} };
}

// update() replaces the whole subscriptionInfo map, so removed keys go away.
async function writeSubscription(ref, info) {
  const batch = writeBatch(db);
  batch.update(ref, { subscriptionInfo: info });
  await batch.commit();
}

// Payment details are no longer tracked; drop any left over from older versions.
function withoutPaymentFields(info) {
  const out = { ...info };
  ['amount', 'paymentStatus', 'paymentDate', 'paymentReference'].forEach((k) => delete out[k]);
  return out;
}

// Approve a pending (or previously rejected) farm. The countdown starts on
// the approval date.
export async function approveFarm(id, input, adminEmail) {
  const body = cleanSubscriptionInput(input);
  const { ref, prevInfo } = await readFarm(id);
  const now = new Date();
  const ts = now.toISOString();
  const info = removeUndefined({
    ...withoutPaymentFields(prevInfo),
    status: 'Active',
    plan: body.plan,
    durationDays: body.durationDays,
    approvalDate: ts,
    startDate: ts,
    expiryDate: now.getTime() + body.durationDays * DAY_MS,
    approvedBy: adminEmail || '',
    blocked: prevInfo.blocked || { blocked: false },
  });
  delete info.rejection;
  await writeSubscription(ref, info);
}

// Renew extends from the current expiry if it hasn't passed yet, otherwise
// from today. Blocked or rejected farms must be unblocked / approved first.
export async function renewFarm(id, input, adminEmail) {
  const body = cleanSubscriptionInput(input);
  const { ref, prevInfo } = await readFarm(id);
  if (prevInfo.blocked?.blocked) throw new Error('Unblock this farm before renewing it.');
  if (prevInfo.status !== 'Active') throw new Error('Only approved farms can be renewed. Approve it first.');
  const now = Date.now();
  const currentExpiry = toMillis(prevInfo.expiryDate);
  const base = currentExpiry && currentExpiry > now ? currentExpiry : now;
  const info = removeUndefined({
    ...withoutPaymentFields(prevInfo),
    status: 'Active',
    plan: body.plan,
    durationDays: body.durationDays,
    renewalDate: new Date(now).toISOString(),
    renewedBy: adminEmail || '',
    expiryDate: base + body.durationDays * DAY_MS,
  });
  await writeSubscription(ref, info);
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
  { id: 'plan-1y', name: '1 Year', days: 365 },
  { id: 'plan-6m', name: '6 Months', days: 180 },
];
export const DEFAULT_CONTACT = { name: 'My Goat Farms Support', mobile: '', phones: [], emails: ['mygoatfarm20@gmail.com'] };

export async function getPlans() {
  const snap = await getDoc(plansRef);
  const plans = snap.exists() ? snap.data().plans : null;
  if (!Array.isArray(plans) || !plans.length) return DEFAULT_PLANS.map((p) => ({ ...p }));
  return plans.map((p, i) => ({ id: str(p.id) || `plan-${i}`, name: str(p.name), days: Number(p.days) || 1 }));
}

export async function savePlans(plans) {
  if (!Array.isArray(plans) || !plans.length) throw new Error('Add at least one plan.');
  if (plans.length > 20) throw new Error('Keep it to 20 plans or fewer.');
  const seen = new Set();
  const clean = plans.map((p) => {
    const body = { name: str(p.name).trim(), days: String(p.days ?? '').trim() };
    assertValid(body, schemas.plan);
    const key = body.name.toLowerCase();
    if (seen.has(key)) throw new Error(`Two plans are called "${body.name}". Give each plan its own name.`);
    seen.add(key);
    return { id: str(p.id) || `plan-${Date.now()}`, name: body.name, days: Number(body.days) };
  });
  await setDoc(plansRef, { plans: clean, updatedAt: nowIso() });
  return clean;
}

// config/adminContact is what the app's approval-waiting screen shows.
// New fields: name, mobile, phones[], emails[]. The single `phone` and
// `email` fields are still written (mobile and first email) so app
// versions that only know those keep working.
const uniq = (list) => [...new Set(list.map((x) => str(x).trim()).filter(Boolean))];

export async function getAdminContact() {
  const snap = await getDoc(doc(db, 'config', 'adminContact'));
  if (!snap.exists()) return { ...DEFAULT_CONTACT, phones: [], emails: [...DEFAULT_CONTACT.emails] };
  const d = snap.data() || {};
  const emails = uniq([...(Array.isArray(d.emails) ? d.emails : []), d.email]);
  const mobile = str(d.mobile || d.phone).trim();
  const phones = uniq(Array.isArray(d.phones) ? d.phones : []).filter((p) => p !== mobile);
  return { name: str(d.name) || DEFAULT_CONTACT.name, mobile, phones, emails: emails.length ? emails : [...DEFAULT_CONTACT.emails], updatedAt: d.updatedAt || null };
}

export async function saveAdminContact(input) {
  const name = str(input.name).trim();
  const mobileRaw = str(input.mobile).trim();
  const emails = uniq((input.emails || []).map((e) => str(e).trim().toLowerCase()));
  const phonesRaw = uniq(input.phones || []);

  assertValid({ name, mobile: mobileRaw }, schemas.contact);
  if (!emails.length) throw Object.assign(new Error('Add at least one email.'), { code: 'invalid-input' });
  if (emails.length > 5) throw new Error('Keep it to 5 emails or fewer.');
  if (phonesRaw.length > 5) throw new Error('Keep it to 5 extra phone numbers or fewer.');
  emails.forEach((e) => { const m = check(e, [rules.email()]); if (m) throw Object.assign(new Error(m), { code: 'invalid-input' }); });
  phonesRaw.forEach((p) => { const m = check(p, [rules.phone()]); if (m) throw Object.assign(new Error(m), { code: 'invalid-input' }); });

  const mobile = normalizePhone(mobileRaw);
  const phones = uniq(phonesRaw.map(normalizePhone)).filter((p) => p !== mobile);
  const safe = { name, mobile, phones, emails, phone: mobile, email: emails[0], updatedAt: nowIso() };
  await setDoc(doc(db, 'config', 'adminContact'), safe);
  return { name, mobile, phones, emails, updatedAt: safe.updatedAt };
}

/* ==============================================================
   ADMIN CHECK
   ============================================================== */

export async function isAdminUid(uid) {
  const snap = await getDoc(doc(db, 'admins', uid));
  return snap.exists();
}

