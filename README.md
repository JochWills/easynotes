# EasyNotes

A South African study-notes marketplace. Verified academics run their own storefronts and sell PDF notes; students buy as guests with Paystack and download straight away. Payments are split with Paystack subaccounts so each seller is paid directly and EasyNotes keeps a flat percentage.

**Stack:** Node 20 + Express 5, server-rendered EJS, Supabase (Postgres + private file storage), Paystack, hosted on Render.

---

## How it works

**Students (no account)**
- Browse/search by module code, subject, institution and level.
- Enter email, tick "all sales are final", pay on Paystack.
- On return, a popup shows their payment reference + email and a Download button.
- Re-download any time at `/download` with email + reference (limit set by `MAX_DOWNLOADS`).
- Each download is a signed Supabase URL that expires after 60 seconds, so links can't be shared.

**Sellers**
1. Sign up → storefront at `/s/their-name`.
2. Upload degree certificate/transcript + ID → status "In review".
3. Add bank details → a Paystack subaccount is created.
4. Once you approve them, they upload PDFs (max 50 MB) with an optional free sample, and set their own price (R10–R2,000).

Notes only appear to students when **all three** are true: note published, seller approved, payout account set up.

**Admin (`/admin`)**
- Review verification documents (10-minute private links), approve / reject with a reason / revoke.
- Hide or remove any listing (removed notes can't be republished by the seller).
- View orders, look up a reference, reset a buyer's download limit.
- Revenue totals.

**Money flow**
- Each checkout sends `transaction_charge` = your platform fee in cents, so the split always matches `PLATFORM_FEE_PERCENT`.
- `PAYSTACK_FEE_BEARER=account` → EasyNotes absorbs Paystack's fee from its cut. Set to `subaccount` to deduct it from the seller's share instead.
- Orders are confirmed twice (browser callback + signed webhook) and the logic is idempotent.

---

## Setup

### 1. Supabase
1. Create a project (choose a region close to SA, e.g. `eu-west` / Frankfurt or wherever latency is best).
2. **SQL Editor** → paste and run `supabase/schema.sql`. This creates the tables, RLS lock-down, helper functions and the three storage buckets:
   - `notes` (private) – the PDFs buyers pay for
   - `samples` (public) – free previews
   - `verification` (private) – degree + ID documents
3. **Project settings → API**: copy the Project URL and the **service_role** key.

> The service role key bypasses all security. It only lives in Render's environment variables and is never sent to the browser.

### 2. Paystack
1. Make sure your Paystack business is activated for ZAR.
2. **Settings → API Keys & Webhooks**: copy your secret key (`sk_test_…` while testing, `sk_live_…` when live).
3. Set the **Webhook URL** to `https://YOUR-DOMAIN/webhooks/paystack`.
4. Leave the callback URL blank in the dashboard – the app sends it per transaction.

### 3. Render
1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → pick the repo (it reads `render.yaml`), or create a Web Service manually with:
   - Build: `npm ci`  Start: `npm start`  Health check: `/healthz`
3. Fill in the env vars: `BASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_SECRET_KEY` (`SESSION_SECRET` is generated for you).
4. Add your custom domain (e.g. `easynotes.co.za`) under the service's Settings, then update `BASE_URL` to match.

The Starter plan is recommended: the free plan sleeps after inactivity, which makes the first page load slow and can delay Paystack webhooks.

### 4. Create your admin login
Locally, with a `.env` filled in (copy `.env.example`), or from Render's Shell tab:
```bash
npm run create-admin -- you@easynotes.co.za "a-long-password"
```
Then log in at `/login` → you'll land on `/admin`.

### Run locally
```bash
cp .env.example .env   # fill it in
npm install
npm run dev            # http://localhost:3000
```
Paystack can't reach `localhost` for webhooks, but the browser callback still confirms payments, so test checkouts work locally. Use Paystack's test cards.

`node test/render-views.js` renders every template with mock data – a quick check after editing views.

---

## Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | Public URL, used for the Paystack callback |
| `SESSION_SECRET` | — | Signs the login cookie |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Database + storage |
| `PAYSTACK_SECRET_KEY` | — | Payments, subaccounts, webhook signature |
| `PLATFORM_FEE_PERCENT` | `20` | Your cut of each sale |
| `PAYSTACK_FEE_BEARER` | `account` | Who pays Paystack's fee |
| `MAX_DOWNLOADS` | `10` | Downloads allowed per purchase |
| `SUPPORT_EMAIL` | `support@easynotes.co.za` | Shown across the site |

Changing `PLATFORM_FEE_PERCENT` applies to new sales immediately. Existing subaccounts keep their old default percentage in Paystack, but the app overrides it on every transaction, so that doesn't matter.

---

## Project layout
```
src/
  server.js            Express app, security headers, sessions, CSRF
  lib/                 config, supabase, paystack, storage, auth, orders, helpers
  routes/
    public.js          home, browse, note page, storefronts, info pages
    checkout.js        Paystack checkout, callback, download
    webhooks.js        Paystack webhook (signature-checked)
    auth.js            seller signup / login / logout
    seller.js          dashboard, storefront, verification, payouts, notes, sales
    admin.js           verification review, moderation, orders
views/                 EJS templates
public/                CSS, JS, favicon
supabase/schema.sql    database + buckets
```

## Security notes
- Passwords hashed with bcrypt; login/signup/download rate-limited.
- CSRF tokens on every form; strict Content-Security-Policy.
- Uploaded files are checked by their actual bytes (not the filename) before storage.
- Buyer emails are masked in the seller's sales view.

## Ideas for later
- Email the download link + reference after payment (Resend/Postmark, triggered from `markPaid`).
- Email admins when a seller submits verification.
- Password reset by email.
- Watermark each PDF with the buyer's email at download time (discourages sharing).
- Reviews/ratings from verified buyers.
