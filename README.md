# My Goat Farms — Admin Website

A pure static website — plain HTML, CSS and JavaScript, no backend server.
It's a **separate, additive layer** on top of your existing Flutter app's
Firebase project: nothing here changes how farmers/owners/partners use the
app. It reads and manages one thing — each farm's subscription — through a
single new field (`subscriptionInfo`) and a few brand-new collections that
your app has never used.

```
mygoatfarms/
├── firestore.rules         ← YOUR real app's rules, unchanged, plus admin
│                             additions clearly marked "ADMIN ADDITION"
└── frontend/                ← the whole admin+public website — upload this
    ├── index.html            public landing page + Contact/Enquiry form
    ├── 404.html, robots.txt
    ├── admin/                index.html (hidden login), dashboard.html, farms.html,
    │                         subscriptions.html, payments.html, earnings.html,
    │                         enquiries.html, reports.html, settings.html
    └── assets/
        ├── css/              styles.css, admin.css, landing.css
        ├── js/
        │   ├── firebase-config.js   ← put YOUR Firebase project config here
        │   ├── db.js                ← all Firestore reads/writes live here
        │   ├── auth-guard.js        ← confirms a visitor is a signed-in admin
        │   ├── admin-shell.js       ← shared sidebar/topbar for every admin page
        │   └── *.js                 ← one file per page (farms.js, enquiries.js, …)
        ├── img/, fonts/
```

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
   object → paste it into `frontend/assets/js/firebase-config.js`,
   replacing the `YOUR_...` placeholders. This is the only file you need
   to edit before deploying.

## Deploying (any static host)

- **Firebase Hosting**: `firebase init hosting` (public directory =
  `frontend`), then `firebase deploy`.
- **Netlify / Vercel**: drag-and-drop the `frontend` folder, or connect the
  repo with publish directory `frontend`.
- **Any regular web host / cPanel**: upload the *contents* of `frontend/`
  to your domain's public folder. No build step, no Node, nothing to
  install or run — ever.

## Restructure progress

**Done**
- Merged `firestore.rules`: real app rules untouched, admin additions
  clearly marked, `subscriptionInfo`-scoped write access for admins
- Farm lifecycle: Pending → Approve (subscription countdown starts on the
  approval date) / Reject, plus Block, Unblock and Renew, all writing only
  `subscriptionInfo` — `farms.html` / `farms.js`
- Removed "Add Farm" and "Delete Farm" from the admin panel — not
  compatible with how farms are actually created, and deleting a farm doc
  would orphan every subcollection under it
- Payments recorded automatically on approve/renew into `subscriptionPayments`
  (kept separate from your `farms/{farmId}/payments`), plus an Earnings
  summary — `payments.html`, `earnings.html`
- One-way visitor → admin Enquiry inbox with bulk mark-read/delete
- Configurable subscription plans (`adminSettings/subscriptionPlans`) —
  `settings.html`
- Reports page with CSV export (Farm Report no longer date-filterable,
  since `FarmModel` has no registration-date field to filter on)
- Public Contact form writes straight to Firestore, validated by rules

**Still worth doing next**
- Consider Firebase **App Check** to cut down on spam/abuse of the public
  enquiry form, since there's no server-side rate limiter.
- If you'd like the Farms page to show farm size/stock, that data lives in
  the `ownFarmGoats` / `tradingGoats` / `stockItems` subcollections, not on
  the farm document itself — would need a per-farm count query, which is
  more expensive at scale than the current single list query.
