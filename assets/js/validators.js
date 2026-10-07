// Shared validators for every form on the site (public Contact form and the
// admin panel). Each rule returns '' when the value is fine, or a short
// message saying what to fix. The same rules run again inside db.js right
// before anything is written, so a bypassed form still can't save bad data.
// Firestore rules (firestore.rules) enforce the hard limits server-side.

export const LIMITS = {
  name: 100,
  email: 254,
  phone: 20,
  subject: 150,
  message: 2000,
  reason: 300,
  planName: 40,
  maxDays: 3650,        // 10 years
};

// name@domain.tld — letters, digits and . _ % + - before the @; a domain
// made of labels (no leading/trailing hyphen) and a 2+ letter ending; no
// spaces and no ".." anywhere.
const EMAIL_RE = /^(?!.*\.\.)[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

// Indian mobile numbers: optional +91 / 91 / 0 prefix, then 10 digits
// starting with 6–9. Spaces, dashes and brackets are ignored.
export function normalizePhone(value) {
  let digits = String(value || '').replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

export const rules = {
  required: (label) => (v) => (String(v ?? '').trim() ? '' : `Enter ${label}.`),
  maxLen: (n, label) => (v) => (String(v ?? '').trim().length <= n ? '' : `${label} must be ${n} characters or fewer.`),
  minLen: (n, label) => (v) => (!String(v ?? '').trim() || String(v).trim().length >= n ? '' : `${label} must be at least ${n} characters.`),
  email: () => (v) => {
    const s = String(v ?? '').trim();
    if (!s) return '';
    if (/\s/.test(s)) return "An email address can't contain spaces.";
    if ((s.match(/@/g) || []).length !== 1) return 'An email address needs exactly one @.';
    const [local] = s.split('@');
    if (local.length > 64 || local.startsWith('.') || local.endsWith('.')) return 'Check the part before the @.';
    return EMAIL_RE.test(s) ? '' : 'Enter a valid email address, like name@example.com.';
  },
  noEdgeSpaces: (label) => (v) => (String(v ?? '') !== String(v ?? '').trim() ? `${label} starts or ends with a space. Remove it if that wasn't intended.` : ''),
  phone: () => (v) => {
    if (!String(v ?? '').trim()) return '';
    return /^[6-9]\d{9}$/.test(normalizePhone(v)) ? '' : 'Enter a 10-digit Indian mobile number, like 98765 43210.';
  },
  integer: (label, min, max) => (v) => {
    const s = String(v ?? '').trim();
    if (!s) return `Enter ${label}.`;
    const n = Number(s);
    if (!Number.isInteger(n)) return `${capitalize(label)} must be a whole number.`;
    if (n < min) return `${capitalize(label)} must be at least ${min.toLocaleString('en-IN')}.`;
    if (n > max) return `${capitalize(label)} can't be more than ${max.toLocaleString('en-IN')}.`;
    return '';
  },
  dateNotFuture: (label) => (v) => {
    const s = String(v ?? '').trim();
    if (!s) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(s).getTime())) return `Enter a valid ${label}.`;
    return s > localDateKey(new Date()) ? `${capitalize(label)} can't be in the future.` : '';
  },
  oneOf: (list, label) => (v) => (list.includes(v) ? '' : `Choose a ${label}.`),
  noFormula: (label) => (v) => (/^[=+\-@]/.test(String(v ?? '').trim()) ? `${label} can't start with = + - or @.` : ''),
};

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

export function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Runs a list of rules against one value; returns the first error or ''. */
export function check(value, ruleList) {
  for (const rule of ruleList) {
    const msg = rule(value);
    if (msg) return msg;
  }
  return '';
}

/** Validates a plain object against { field: [rules] }. Returns { field: msg } for failures. */
export function validateObject(obj, schema) {
  const errors = {};
  for (const [key, ruleList] of Object.entries(schema)) {
    const msg = check(obj[key], ruleList);
    if (msg) errors[key] = msg;
  }
  return errors;
}

/* ---------------- Schemas shared by the forms and db.js ---------------- */

export const schemas = {
  enquiry: {
    name: [rules.required('your name'), rules.maxLen(LIMITS.name, 'Name')],
    email: [rules.required('your email'), rules.maxLen(LIMITS.email, 'Email'), rules.email()],
    phone: [rules.maxLen(LIMITS.phone, 'Phone'), rules.phone()],
    subject: [rules.required('a subject'), rules.minLen(3, 'Subject'), rules.maxLen(LIMITS.subject, 'Subject')],
    message: [rules.required('a message'), rules.minLen(10, 'Message'), rules.maxLen(LIMITS.message, 'Message')],
  },
  login: {
    email: [rules.required('your email'), rules.maxLen(LIMITS.email, 'Email'), rules.email()],
    // Firebase accounts need at least 6 characters; anything shorter can't
    // be a real password, so don't spend a sign-in attempt on it.
    password: [rules.required('your password'), rules.minLen(6, 'Password'), rules.maxLen(128, 'Password')],
  },
  subscription: {
    plan: [rules.required('a plan'), rules.maxLen(LIMITS.planName, 'Plan name')],
    durationDays: [rules.integer('duration', 1, LIMITS.maxDays)],
  },
  reason: {
    reason: [rules.required('a reason'), rules.minLen(5, 'Reason'), rules.maxLen(LIMITS.reason, 'Reason')],
  },
  plan: {
    name: [rules.required('a plan name'), rules.maxLen(LIMITS.planName, 'Plan name'), rules.noFormula('Plan name')],
    days: [rules.integer('duration', 1, LIMITS.maxDays)],
  },
  contact: {
    name: [rules.required("the admin's name"), rules.maxLen(LIMITS.name, 'Name')],
    mobile: [rules.required("the admin's mobile number"), rules.phone()],
  },
  contactEmail: [rules.email()],
  contactPhone: [rules.phone()],
};

/** Throws an Error carrying .fields when the object fails its schema. */
export function assertValid(obj, schema) {
  const errors = validateObject(obj, schema);
  const keys = Object.keys(errors);
  if (keys.length) {
    const err = new Error(errors[keys[0]]);
    err.fields = errors;
    err.code = 'invalid-input';
    throw err;
  }
}

/* ---------------- DOM helpers: inline field errors ---------------- */

function errorNodeFor(input) {
  const field = input.closest('.field') || input.parentElement;
  let node = field.querySelector(':scope > .field-error');
  if (!node) {
    node = document.createElement('p');
    node.className = 'field-error';
    node.id = `${input.id || Math.random().toString(36).slice(2)}-error`;
    field.appendChild(node);
  }
  return node;
}

export function setFieldError(input, msg) {
  if (!input) return;
  const node = errorNodeFor(input);
  node.textContent = msg || '';
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  if (msg) input.setAttribute('aria-describedby', node.id);
  else input.removeAttribute('aria-describedby');
}

/**
 * Wires live validation to a form.
 * fields: { key: inputElement }, schema: { key: [rules] }.
 * Errors show after a field is left (blur) or after the first submit,
 * then update as the person types. Returns { validate(), values(), reset() }.
 */
export function bindForm(fields, schema, { extra } = {}) {
  const touched = new Set();
  let submitted = false;

  const valueOf = (el) => (el.type === 'checkbox' ? el.checked : el.value);
  const values = () => Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, valueOf(el)]));

  const checkOne = (key) => {
    const all = values();
    let msg = check(all[key], schema[key] || []);
    if (!msg && extra) msg = (extra(all) || {})[key] || '';
    if (touched.has(key) || submitted) setFieldError(fields[key], msg);
    return msg;
  };

  for (const [key, el] of Object.entries(fields)) {
    el.addEventListener('blur', () => { if (String(valueOf(el)).trim()) touched.add(key); checkOne(key); });
    el.addEventListener('input', () => { if (touched.has(key) || submitted) checkOne(key); });
    el.addEventListener('change', () => { if (touched.has(key) || submitted) checkOne(key); });
  }

  return {
    values,
    validate() {
      submitted = true;
      let firstBad = null;
      for (const key of Object.keys(fields)) {
        if (checkOne(key) && !firstBad) firstBad = fields[key];
      }
      if (firstBad) firstBad.focus();
      return !firstBad;
    },
    showErrors(errors) {
      for (const [key, msg] of Object.entries(errors || {})) if (fields[key]) setFieldError(fields[key], msg);
    },
    reset() {
      submitted = false;
      touched.clear();
      Object.values(fields).forEach((el) => setFieldError(el, ''));
    },
  };
}
