# Stripe Terminal S710

The admin appointment modal uses Stripe's server-driven integration. The
browser never connects directly to the reader: authenticated admin routes send
the appointment's exact service price to the configured S710 through Stripe.

## Production reader setup

1. In Stripe Dashboard, switch to **Live mode**.
2. Open **More → Terminal → Locations** and create/select the studio location.
3. On the S710, open **Settings**, generate a pairing code, then register the
   reader to that location in Stripe Dashboard.
4. Copy the reader id (`tmr_…`) and location id (`tml_…`) into Vercel
   Production:

   ```text
   STRIPE_TERMINAL_READER_ID=tmr_…
   STRIPE_TERMINAL_LOCATION_ID=tml_…
   ```

5. Under the Terminal location/configuration tipping settings, enable
   percentage tips of **10%, 15%, and 20%**. Keep custom tip and no tip
   available.

The application sends `amount_eligible` equal to the exact service subtotal.
Stripe adds the reader-selected tip before authorization and returns it in
`PaymentIntent.amount_details.tip.amount`.

## Webhook

Create a Stripe webhook endpoint for:

```text
https://www.sadiemarie.co/api/stripe/webhook
```

Subscribe to:

- `terminal.reader.action_succeeded`
- `terminal.reader.action_failed`
- `terminal.reader.action_updated`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `payment_intent.processing`

Copy the endpoint signing secret (`whsec_…`) to Vercel Production as:

```text
STRIPE_WEBHOOK_SECRET=whsec_…
```

Create a separate endpoint for staging using
`https://staging.sadiemarie.co/api/stripe/webhook` while Stripe Dashboard is in
test mode. Never share the live signing secret with staging.

## Staging simulated reader

Staging uses Stripe test keys and must use a test-mode reader. Create one with
Stripe's `simulated-s710` registration code and assign it to a test-mode
Terminal location. Store those test `tmr_…`, `tml_…`, and `whsec_…` values on
the Vercel staging environment only.

The simulated reader has no screen. After starting a payment in the admin UI,
use Stripe's Terminal test helper `present_payment_method` for the simulated
reader to approve or decline it. A physical S710 in test mode plus a Stripe
physical test card is required to inspect the actual on-reader tip UI.

## Database migration

Run the idempotent payment-ledger migration against staging and production
before deploying code that reads `appointment_payments`:

```bash
node --env-file=.env.local scripts/run-appointment-payments-migration.mjs
```

The ledger keeps service payment state separate from the appointment lifecycle.
Only one active/successful service payment is allowed per appointment, and a
failed card attempt reuses the same Stripe PaymentIntent. The migration also
snapshots each appointment's quoted service price so later catalog edits cannot
change the amount charged.

## Admin flow

1. Open a confirmed appointment with a valid service price.
2. Click **Charge $X**.
3. Confirm **Send to terminal**.
4. The S710 presents 10% / 15% / 20% / custom / no tip, then asks the client
   to tap, insert, or swipe.
5. The modal polls while webhooks reconcile the authoritative result.
6. Success shows service subtotal, tip, total, and a persistent **Paid** badge.

If the reader declines or disconnects, use **Try reader again**. The same
PaymentIntent is reused to avoid duplicate charges. **Cancel payment** cancels
the reader action and abandons the PaymentIntent when Stripe allows it.

## Operational notes

- Server-driven Terminal requires internet access; it cannot collect offline.
- Only one reader action can run at a time.
- A timeout can be a false negative, so the app retrieves both the reader and
  PaymentIntent before reporting failure.
- Check `/admin/health` after every environment or reader change. It validates
  reader mode, location, online state, and webhook configuration.
