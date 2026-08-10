# Apple Pay (phone booker)

Apple Pay is the primary secure-hold CTA on the phone `/book` review
screen when the device supports it. Manual card entry still uses
`/checkout`.

## Stripe Dashboard (required)

Apple Pay will not appear until domains are registered in Stripe:

1. Stripe Dashboard → **Settings** → **Payment methods** → **Apple Pay**
   (or **Payment method domains**)
2. Register (test + live as needed):
   - `www.sadiemarie.co`
   - `staging.sadiemarie.co`
3. Complete domain verification (Stripe hosts the Apple association file
   for Dashboard-verified domains).

Localhost does not show live Apple Pay; use a real Safari / iPhone against
staging after domain registration.

## Flow

1. Guest reaches `/book` review (summary) — **no hold yet**.
2. If Apple Pay is available: tap Apple Pay → create hold → SetupIntent →
   confirm → `/api/booking/confirm` → success on `/book`.
3. Otherwise (or “Pay with card instead”): create hold → `/checkout` card
   Payment Element (unchanged).

Still vault-only (`SetupIntent`, `usage: off_session`) — no charge today.
Apple Pay uses Express Checkout in setup mode (no deferred merchant-token
options on this surface).
