# Apple Pay (phone booker)

Apple Pay is the primary secure-hold CTA on the phone `/book` review
screen when the device supports it. Manual card entry still uses
`/checkout`.

## Stripe Dashboard (required)

Apple Pay will not appear until domains are registered in Stripe **in the
same mode as the publishable key** on that host:

| Host | Stripe keys | Dashboard mode |
| --- | --- | --- |
| `www.sadiemarie.co` | live (`pk_live_`) | **Live** mode |
| `staging.sadiemarie.co` | test (`pk_test_`) | **Test** mode (toggle in the Dashboard sidebar) |

1. Stripe Dashboard → toggle **Test mode** (staging) or leave Live (www)
2. **Settings** → **Payments** → **Payment method domains**
3. Add and enable:
   - Live: `www.sadiemarie.co`
   - Test: `staging.sadiemarie.co`
4. Complete domain verification (Stripe hosts the Apple association file
   for Dashboard-verified domains). Staging must serve
   `/.well-known/apple-developer-merchantid-domain-association` without
   redirecting to www (see `proxy.ts`).

Live-mode domain rows do **not** unlock Apple Pay on staging’s test keys —
that’s why www can show Apple Pay while staging falls back to
“Continue to checkout”.

Localhost does not show live Apple Pay; use a real Safari / iPhone against
staging after **test-mode** domain registration.

## Flow

1. Guest reaches `/book` review (summary) — **no hold yet**.
2. If Apple Pay is available: tap Apple Pay → create hold → SetupIntent →
   confirm → `/api/booking/confirm` → success on `/book`.
3. Otherwise (or “Pay with card instead”): create hold → `/checkout` card
   Payment Element (unchanged).

Still vault-only (`SetupIntent`, `usage: off_session`) — no charge today.
Apple Pay uses Express Checkout in setup mode (no deferred merchant-token
options on this surface).
