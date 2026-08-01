# Launch smoke checklist (manual)

Run after staging deploy, then again on production.

## Pre-flight
- [ ] Vercel env has `CAL_WEBHOOK_SECRET` (Production + Preview/Staging)
- [ ] Same secret pasted into Cal.com webhook settings for the production URL
- [ ] Rate-limit migration applied on **production** Neon:
  `node --env-file=.env.production.local scripts/run-rate-limit-buckets-migration.mjs`
  (or `vercel env pull` for production, then run)
- [ ] `/admin` → Health Check: overall healthy (especially env-critical, cal-schedules, cal-webhook via env, db-consent-template, stripe mode)

## Booking path
- [ ] Homepage services visible; hours line present
- [ ] Book a service → drawer opens → pick slot → fill phone
- [ ] `/checkout` countdown visible; card form loads
- [ ] Confirm with card → success; admin calendar shows **confirmed**
- [ ] Cal.com dashboard shows booking accepted

## Hold release
- [ ] Start another booking to checkout, wait until 00:00 (or 10+ min)
- [ ] Slot frees; confirm after expiry returns hold expired

## Consent
- [ ] Open consent link; submit with signature succeeds
- [ ] Server validation rejects incomplete payloads with 400 `validation_failed`
  (e.g. `POST /api/consent/preview` with empty `full_name` — no DB write).
  Note: `agreement_date` is forced to studio “today” in `prepareConsentFormForServer`
  before validate, so a backdated date alone will not 400.

## Webhook
- [ ] POST `/api/webhook` without signature → 401
- [ ] Real Cal booking still delivers webhook 200
