# Apple Pay (phone booker)

Apple Pay is the primary secure-hold CTA on the phone `/book` review
screen when the device supports it. Manual card entry still uses
`/checkout`.

## Stripe Dashboard (required)

Apple Pay will not appear until domains are registered in Stripe **in the
same mode / sandbox as the publishable key** baked into that host:

| Host | Stripe keys | Dashboard mode |
| --- | --- | --- |
| `www.sadiemarie.co` | live (`pk_live_`) | **Live** mode |
| `staging.sadiemarie.co` | test (`pk_test_`) | **Test / Sandbox** |

1. Open the Stripe Dashboard for the **same account whose keys are on Vercel**
   for that host (Staging Preview env). In Test/Sandbox, open
   **Developers → API keys** and confirm the publishable key matches staging.
2. **Settings** → **Payments** → **Payment method domains** (still in that
   Test/Sandbox).
3. Add and enable `staging.sadiemarie.co` (live: `www.sadiemarie.co`).
4. Also confirm **Settings → Payment methods** has **Apple Pay** enabled for
   that mode.
5. Staging must serve
   `/.well-known/apple-developer-merchantid-domain-association` without
   redirecting to www (see `proxy.ts`).

Domains registered in Live do **not** unlock Apple Pay for staging’s test
keys. Domains registered in a *different* Stripe Sandbox than the keys on
Vercel also will not. You do **not** need to leave the Dashboard toggled to
Test mode while browsing the site — only the domain registration + keys
must match.

Localhost does not show live Apple Pay; use a real Safari / iPhone against
staging after test-domain registration.

## Flow

1. Guest reaches `/book` review (summary) — **no hold yet**.
2. If Apple Pay is available: tap Apple Pay → create hold → SetupIntent →
   confirm → `/api/booking/confirm` → success on `/book`.
3. Otherwise (or “Pay with card instead”): create hold → `/checkout` card
   Payment Element (unchanged).

Still vault-only (`SetupIntent`, `usage: off_session`) — no charge today.
Apple Pay uses Express Checkout in setup mode (no deferred merchant-token
options on this surface).
