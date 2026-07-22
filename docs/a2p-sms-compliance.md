# A2P 10DLC / Twilio SMS compliance

This document is the source of truth for Sadie Marie’s **transactional appointment SMS** program on Twilio A2P 10DLC. Follow it whenever you change booking opt-in UI, Privacy/Terms, SMS copy, or notification sending logic.

**Brand name (must match Twilio Brand Registration):** `Sadie Marie`  
**Website:** `https://sadiemarie.co`  
**Privacy Policy URL:** `https://sadiemarie.co/privacy`  
**Terms & Conditions URL:** `https://sadiemarie.co/terms`

If the Twilio Brand is registered under a different name (e.g. “Sadie Marie Beauty Studio”), either update the Brand to **Sadie Marie** or update every client-facing legal/opt-in surface to that exact registered name. Brand mismatch causes rejection.

---

## Why this exists

Twilio campaign `CMa697b419c00ef6b56989f6f0bf050d1c` was rejected (July 2026) for:

| Code | Meaning |
|------|---------|
| **30908** | Privacy Policy missing / noncompliant (especially mobile non-sharing) |
| **30896** | Opt-in / `message_flow` not clear enough |
| **30882** | Terms don’t meet A2P rules (consent bundled / third-party risk) |
| **Forced consent** | SMS treated as required to complete booking |
| **Brand mismatch** | Privacy/Terms brand ≠ campaign brand |

Do not reintroduce those failure modes.

---

## Non-negotiable rules

### 1. SMS opt-in must be optional (forced-consent ban)

- End users must be able to **complete a booking without** agreeing to SMS.
- Opt-in must be a **separate checkbox**, not implied by:
  - agreeing to Terms of Service
  - submitting the booking form
  - providing a phone number
- Checkbox field: Cal booking field `sms-consent` (`type: boolean`, **`required: false`**).
- Label must state that **consent is not required to book**.
- Never prefix the label with “Required —” or set `required: true` on `sms-consent`.

**Code:** `lib/cal-event-studio-defaults.ts` → `STUDIO_BOOKING_FIELDS` / `STUDIO_SMS_CONSENT_LABEL`  
**Backfill after label/required changes:**  
`node --env-file=.env.local scripts/backfill-cal-event-studio-defaults.mjs`

### 2. Do not send SMS without explicit opt-in

Public Cal bookings must only trigger Twilio SMS when `sms-consent` is **explicitly true**.

- Webhook parses `sms-consent` and passes `smsOptIn: true` only when checked.
- If unchecked / missing on a website booking → **no** confirmation SMS and **no** QStash remind/feedback SMS jobs.
- Admin manual bookings may pass `smsOptIn: true` (staff-initiated outreach).

**Code:** `lib/legacy-handlers/webhook.js`, `lib/booking-notifications.js`

### 3. Privacy Policy must include these disclosures

Public page: `public/privacy.html` → `https://sadiemarie.co/privacy`

Required content:

1. **Brand** identified as **Sadie Marie** (same as Twilio Brand).
2. **Optional opt-in** described: checkbox on booking form; phone alone ≠ consent; not required to book/purchase.
3. **Message frequency** (e.g. varies; typically a few messages per booking).
4. **“Message and data rates may apply.”**
5. **STOP / HELP** opt-out / help instructions.
6. **Exact non-sharing statement** (or equivalent that covers mobile **and** messaging consent, third parties **and** affiliates, marketing/promotional):

   > We do not share, sell, or otherwise provide your mobile phone number or messaging consent information to any third parties or affiliates for marketing or promotional purposes.

7. Link to Terms: `https://sadiemarie.co/terms`.

Twilio auto-fails policies that say mobile numbers / consent **are** shared for marketing.

### 4. Terms must not bundle SMS into general agreement

Public page: `public/terms.html` → `https://sadiemarie.co/terms`

Required content:

1. Brand **Sadie Marie**.
2. Clear statement that agreeing to Terms / completing a booking **does not** enroll the user in SMS.
3. Dedicated SMS section describing the **optional** checkbox opt-in on `https://sadiemarie.co`.
4. Frequency, rates, STOP/HELP, “consent is not a condition of purchasing services”.
5. Same mobile / messaging-consent **non-sharing** statement.
6. Link to Privacy: `https://sadiemarie.co/privacy`.

### 5. Opt-in checkbox copy (website message flow)

The Cal boolean label should include, in substance:

- Brand: Sadie Marie  
- What messages: appointment confirmations, reminders, follow-ups  
- Message frequency varies  
- Message and data rates may apply  
- STOP / HELP  
- Consent is not required to book  
- Links: `https://sadiemarie.co/privacy` and `https://sadiemarie.co/terms`

Keep Privacy/Terms as full `https://` URLs so reviewers (and auto-linkification) can verify them on the booking form itself.

### 6. Campaign registration fields (Twilio Console)

When creating or **editing/resubmitting** the campaign (prefer edit, don’t recreate):

| Field | Value |
|-------|--------|
| Use case | Customer Care / transactional appointment messaging (not promotional blast / affiliate) |
| Website | `https://sadiemarie.co` |
| Privacy Policy URL | `https://sadiemarie.co/privacy` |
| Terms URL | `https://sadiemarie.co/terms` |
| Opt-in type | Web form |

**`message_flow` / opt-in description (paste-ready):**

```text
End users opt in on the Sadie Marie website at https://sadiemarie.co when booking an appointment. After selecting a service and time, they reach the booking details form where they may optionally check a separate SMS consent checkbox (not required to complete the booking). The checkbox label states that they agree to receive appointment texts from Sadie Marie (confirmations, reminders, and follow-ups); message frequency varies; message and data rates may apply; reply STOP to opt out or HELP for help; consent is not required to book; and links to https://sadiemarie.co/privacy and https://sadiemarie.co/terms. Providing a phone number alone does not opt the user into SMS. Privacy Policy (https://sadiemarie.co/privacy) states that Sadie Marie does not share, sell, or otherwise provide mobile phone numbers or messaging consent information to any third parties or affiliates for marketing or promotional purposes.
```

Sample messages should identify **Sadie Marie** by name and include opt-out language in at least one sample (e.g. Reply STOP to opt out).

### Sample messages (canonical — keep code in sync)

**Opt-in reply** (START / YES / UNSTOP — configure in Twilio Console):

```text
Sadie Marie: You are opted in to appointment messages (confirmations, reminders, and follow-ups). Msg frequency varies. Msg & data rates may apply. Reply HELP for help. Reply STOP to opt out. Privacy: https://sadiemarie.co/privacy
```

**#1 – Confirmation** (sent from `/api/booking/confirm` after card vault):

```text
Sadie Marie: Your [service] is confirmed for [date] at [time]. Manage, reschedule, or cancel: [link]. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

**#2 – 24h reminder** (`/api/remind` kind=`24h`):

```text
Sadie Marie: Reminder — your [service] is tomorrow at [time]. Please arrive with clean lashes and no eye makeup. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

(Brows services substitute clean-brows arrival copy in code.)

**#3 – 1h reminder** (`/api/remind` kind=`1h`):

```text
Sadie Marie: Your [service] is in one hour. Please arrive with clean lashes and no eye makeup. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

**Code:** `lib/sms-appointment-copy.js`, `lib/booking-notifications.js`, `lib/legacy-handlers/remind.js`  
**Send timing:** confirmation + QStash schedules run after checkout confirm (not on Cal `BOOKING_CREATED`).

## File map

| Concern | Files |
|---------|--------|
| Checkbox definition | `lib/cal-event-studio-defaults.ts` |
| Push fields to all Cal event types | `scripts/backfill-cal-event-studio-defaults.mjs` |
| Privacy Policy | `public/privacy.html` |
| Terms | `public/terms.html` |
| Footer legal links | `public/index.html` |
| Gate SMS on opt-in | `lib/booking-notifications.js`, `app/api/booking/confirm/route.ts`, `appointments.sms_opt_in` |
| Reminder SMS | `lib/legacy-handlers/remind.js` (24h + 1h; only if QStash scheduled after confirm + opt-in) |
| SMS copy | `lib/sms-appointment-copy.js` |
| Apply studio fields on new services | `app/api/admin/services/route.ts` |

---

## Checklist before shipping SMS-related changes

- [ ] `sms-consent` remains `required: false`
- [ ] Label still says consent is **not required to book**
- [ ] Label still includes frequency, rates, STOP/HELP, Privacy + Terms URLs
- [ ] Privacy still has the **non-sharing** sentence (mobile + messaging consent; third parties + affiliates; marketing/promotional)
- [ ] Privacy/Terms still say phone ≠ SMS consent and Terms agreement ≠ SMS enrollment
- [ ] Brand string is still **Sadie Marie** on Privacy, Terms, SMS bodies, and Twilio Brand
- [ ] Website bookings only send SMS when `sms-consent === true` (stored as `appointments.sms_opt_in`, sent from `/api/booking/confirm`)
- [ ] Confirmation SMS fires after checkout, not on Cal `BOOKING_CREATED`
- [ ] After changing Cal booking fields, ran the **backfill** script
- [ ] If campaign fields / legal URLs changed, update Twilio Console and resubmit the **same** campaign

---

## Related Twilio references

- [Error 30908 – Privacy Policy](https://www.twilio.com/docs/api/errors/30908)
- [Error 30896 – Opt-in / message_flow](https://www.twilio.com/docs/api/errors/30896)
- [Error 30882 – Terms & Conditions](https://www.twilio.com/docs/api/errors/30882)
- A2P campaign approval best practices (Twilio docs / Messaging Policy)

---

## Intake form vs SMS consent

`/consent/[clientId]` and `has_consented` are **treatment / intake** consent (PDF), **not** A2P SMS opt-in. Do not conflate them in UI copy or in Twilio registration.
