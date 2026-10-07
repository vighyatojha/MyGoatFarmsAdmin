# My Goat Farms — Admin Website

A pure static website — plain HTML, CSS and JavaScript, no backend server.
It's a **separate, additive layer** on top of your existing Flutter app's
Firebase project: nothing here changes how farmers/owners/partners use the
app. It reads and manages one thing — each farm's subscription — through a
single new field (`subscriptionInfo`) and a few brand-new collections that
your app has never used.

```
MyGoatFarmsAdmin/
├── firestore.rules          your app's rules + admin additions and validators
├── index.html               public landing page + Contact form
├── 404.html, robots.txt
├── admin/
│   ├── index.html           the whole admin panel: sign-in + every section
│   └── *.html               old page addresses; they forward to admin/#/<section>
└── assets/
    ├── css/                 admin-app.css (admin), styles.css + landing.css (public)
    └── js/
        ├── firebase-config.js   your Firebase web config
        ├── db.js                every Firestore read/write
        ├── validators.js        form rules shared by every form and db.js
        ├── admin-app.js         the admin panel (router, live data, all sections)
        └── main.js              landing page Contact form
```

## How the admin panel loads

The admin panel is one page (`admin/index.html`). Sections live at
`admin/#/dashboard`, `#/farms`, `#/farms/<farm id>` (one farm in
detail), `#/subscriptions`, `#/enquiries`, `#/reports` and `#/settings`.
Payments and earnings were removed; the admin panel no longer records
money. Old payment records stay in Firestore untouched.

- Farms and enquiries are each read **once** through a live
  Firestore listener when you sign in. Every section draws from that same
  copy, so switching sections never reloads the page or re-fetches data,
  and changes (yours or a new enquiry) appear everywhere straight away.
- Partner/goat counts cost several reads per farm, so they are fetched once
  per farm and only re-read when you press **Refresh counts**.
- Page colours and the app shell are painted before any script runs, so
  there is no white flash. Returning admins see the shell with loading
  placeholders while Firebase confirms the session.

## Validation

`assets/js/validators.js` holds the rules for every form: the Contact
form, sign-in, approve/renew, reject/block reasons, subscription plans
and the support contact. Errors show under each field. `db.js` runs the
same rules again before writing, and `firestore.rules` enforces the hard
limits on the server (marked `VALIDATOR`), including:

- farm owners can no longer change their own `subscriptionInfo`
  (approval, block or expiry) from the app;
- enquiries must have a valid email, bounded fields and an ISO timestamp;
- the support contact (`config/adminContact`) holds the admin's name,
  mobile, up to 5 more phone numbers and 1–5 emails. `phone` and `email`
  are also written (mobile and first email) for app versions that only
  read those.
- a farm's detail page reads partners, Palai customers, goat counts and
  stock only when you open it, using count queries where possible.

**Publish the updated `firestore.rules`** in the Firebase console after
deploying this version.


## How this fits your real database

Your app's Firestore already has a serious owner/partner model
(`farms/{farmId}.authUid`, `farms/{farmId}/partners/{uid}`, sequential
`FRM###` ids via `counters/farms`, a `mobileIndex`, and no concept of
"admin" at all). This admin site adds to that rather than replacing it:

- **One new field on the farm document: `subscriptionInfo`.** Everything
  the admin panel manages — approval status, plan, payment, expiry date,
  blocked/rejected state — lives inside this single map field. `FarmModel`
  in your Flutter app never reads it, so it's invisible to the app and can
  never collide with `farmName`, `ownerName`, `billSettings`, etc.
- **Firestore rules enforce that boundary, not just convention.** The
  admin panel's `update` permission on a farm document is written so it can
  **only ever change the `subscriptionInfo` field** — see the `ADMIN
  ADDITION` comment on `farms/{farmId}`'s `allow update` rule in
  `firestore.rules`. It cannot touch goats, stock, bills, or the farm's
  profile fields, even if the admin website's code had a bug.
- **Farms are never created or deleted by the admin panel.** A farm only
  exists because a real owner signed up in the app (`authUid` + the
  `counters/farms` sequence). The admin panel only approves, rejects,
  renews, blocks or unblocks an *existing* farm's subscription.
- **New, previously-unused top-level collections**: `admins`,
  `subscriptionPayments` (deliberately not named `payments` — your app
  already uses `farms/{farmId}/payments` for customer/Palai billing, a
  completely different thing), `enquiries` (the public Contact form inbox),
  and `adminSettings` (subscription plan definitions).
- Every other rule in `firestore.rules` — owner, partner, goats, stock,
  bills, transactions, everything — is **byte-for-byte the same as what you
  gave me**, except the three spots marked `ADMIN ADDITION`.

## How to add an admin (do this first)

There's no "sign up as admin" button anywhere, on purpose — this is the
entire security model, so it's deliberately a manual, Console-only step:

1. **Deploy the rules**: Firebase Console → Firestore → Rules → paste in
   the full contents of `firestore.rules` from this repo → **Publish**.
   (This is the same project your Flutter app already uses.)
2. **Create the admin's sign-in**: Authentication → Users → **Add user** →
   enter their email + a strong password → Firebase gives you a **User
   UID** — copy it.
3. **Grant admin access**: Firestore → Data → **Start collection** →
   Collection ID: `admins` → **Document ID: paste that same UID** → add any
   field (e.g. `email` = their email, just for your own reference in the
   console) → **Save**.
4. Done. That person can now sign in at `yourdomain.com/admin/` and reach
   the dashboard. To add another admin, repeat steps 2–3 with a new user.
5. To **revoke** an admin, just delete their document from the `admins`
   collection — Firestore rules check for its existence on every request,
   so access disappears immediately, no code change needed.

*(Optional)* Add a document at `adminSettings/subscriptionPlans` with a
`plans` array (`[{id, name, amount, days}]`) if you want different defaults
than the built-in "1 Year / 6 Months" — otherwise those are the fallback,
and you can edit plans from **Settings** inside the admin panel after your
first login anyway.

## One-time Firebase setup (if you haven't already)

Skip anything you've already done for the Flutter app — same project:

1. Firebase project already exists (yours).
2. Authentication → Sign-in method → **Email/Password** enabled.
3. Firestore database already exists (yours).
4. Web app config: Project settings (⚙) → General → "Your apps" → add a
   **Web app** (`</>`) if there isn't one yet → copy the `firebaseConfig`
   object → paste it into `assets/js/firebase-config.js`,
   replacing the `YOUR_...` placeholders. This is the only file you need
   to edit before deploying.

## Deploying (any static host)

- **Firebase Hosting**: `firebase init hosting` (public directory = `.`), then `firebase deploy`.
- **Netlify / Vercel**: drag-and-drop the repo folder, or connect the repo
  with the repo root as the publish directory.
- **Any regular web host / cPanel**: upload the contents of this repo
  to your domain's public folder. No build step, no Node, nothing to
  install or run — ever.

## Going back to the previous version

The version before the single-page redesign is saved on the branch
`backup-before-spa-redesign-20261007`. To restore it on `main`:

```
git checkout main
git reset --hard backup-before-spa-redesign-20261007
git push --force-with-lease origin main
```

(Re-publish the old `firestore.rules` from that branch too if you roll back.)
