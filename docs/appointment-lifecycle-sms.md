# Appointment lifecycle — scenarios & SMS

Every way an appointment can be created or altered in the Sadie Marie app, with the **full** studio SMS text when one is sent, or **none** when no studio SMS is sent.

**Rules that apply to all studio SMS**

- Sent only when `appointments.sms_opt_in === true` (client checked SMS consent), except admin manual booking which forces `sms_opt_in = true`.
- Copy lives in `lib/sms-appointment-copy.js`.
- Example values below use a **2 Week Fill** on **Saturday, July 25 at 10:00am** (Mountain), manage link `https://www.sadiemarie.co/manage.html?uid=jAUwov2YZ7jjfo1QrVUYAA`, and a **$65** no-show fee (50% of a $130 service). Real sends substitute the actual service, time, UID, and amount.

---

## Create

### 1. Public Cal booking → hold

| | |
|---|---|
| **Who** | Client |
| **Status** | `pending` |
| **SMS** | none |
| **Notes** | Slot held ~10 minutes until checkout. No SMS until card is vaulted. |

### 2. Checkout confirm (card vaulted)

| | |
|---|---|
| **Who** | Client |
| **Status** | `confirmed` |
| **SMS** | Yes — confirmation (below) |
| **Notes** | Also schedules 24h + 1h reminder SMS (QStash) and reminder emails. |

```
Sadie Marie: Your 2 Week Fill is confirmed for Saturday, July 25 at 10:00am. Manage, reschedule, or cancel: https://www.sadiemarie.co/manage.html?uid=jAUwov2YZ7jjfo1QrVUYAA. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 3. Admin manual booking complete

| | |
|---|---|
| **Who** | Admin |
| **Status** | `confirmed` |
| **SMS** | Yes — same confirmation as checkout |
| **Notes** | No Stripe vault. `sms_opt_in` forced true. |

```
Sadie Marie: Your 2 Week Fill is confirmed for Saturday, July 25 at 10:00am. Manage, reschedule, or cancel: https://www.sadiemarie.co/manage.html?uid=jAUwov2YZ7jjfo1QrVUYAA. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 4. Cal `BOOKING_REQUESTED` webhook

| | |
|---|---|
| **Who** | Cal |
| **Status** | `pending` |
| **SMS** | none |
| **Notes** | Upserts hold row only. |

### 5. Cal `BOOKING_CREATED` webhook

| | |
|---|---|
| **Who** | Cal |
| **Status** | `pending` (upsert) |
| **SMS** | none |
| **Notes** | SMS intentionally deferred until checkout confirm. |

---

## Alter / cancel / fees

### 6. Abandoned checkout / hold release

| | |
|---|---|
| **Who** | System (QStash / cron / leave checkout) |
| **Status** | `canceled_by_system` |
| **SMS** | none |
| **Notes** | Cancels on Cal with abandon reason. |

### 7. Client cancel via `/manage` (outside 24h window)

| | |
|---|---|
| **Who** | Client |
| **Status** | `canceled_by_client` |
| **SMS** | none |
| **Notes** | Cal may send its own cancellation email. |

### 8. Client cancel via Cal UI / email link (outside 24h)

| | |
|---|---|
| **Who** | Client |
| **Status** | `canceled_by_client` |
| **SMS** | none |
| **Notes** | Cal native cancellation email only. |

### 9. Client cancel within 24h + vaulted card + $20 charge succeeds

| | |
|---|---|
| **Who** | Client + system (webhook) |
| **Status** | `canceled_by_client_late` |
| **SMS** | Yes — late-cancel fee receipt (below) |
| **Notes** | Flat **$20** off-session charge. |

```
Sadie Marie: Your 2 Week Fill on Saturday, July 25 at 10:00am was canceled. A late-cancel fee of $20 was charged to your card on file. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 10. Client cancel within 24h, no card or charge fails

| | |
|---|---|
| **Who** | Client + system |
| **Status** | `canceled_by_client` |
| **SMS** | none |
| **Notes** | Appointment still cancels; no fee SMS. |

### 11. Client cancel after appointment start time

| | |
|---|---|
| **Who** | Client + system |
| **Status** | `canceled_by_client` |
| **SMS** | none |
| **Notes** | Outside late window (`msUntilStart` must be &gt; 0). No $20 fee. |

### 12. Client reschedule via `/manage` or Cal

| | |
|---|---|
| **Who** | Client |
| **Status** | `confirmed` (or stays `pending` if still a hold) |
| **SMS** | Yes when resulting status is `confirmed` — reschedule (below) |
| **Notes** | Manage link uses the **new** Cal UID. Reminder emails + SMS jobs re-queued. |

```
Sadie Marie: Your 2 Week Fill has been rescheduled to Sunday, July 26 at 2:00pm. Manage, reschedule, or cancel: https://www.sadiemarie.co/manage.html?uid=jAUwov2YZ7jjfo1QrVUYAA. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 13. Admin cancel from dashboard

| | |
|---|---|
| **Who** | Admin |
| **Status** | `canceled_by_admin` |
| **SMS** | Yes — admin cancel (below) |
| **Notes** | Also cancels on Cal (Cal may email the client). |

```
Sadie Marie: Your 2 Week Fill on Saturday, July 25 at 10:00am has been canceled. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 14. Admin marks no-show — no charge

| | |
|---|---|
| **Who** | Admin |
| **Status** | `no-show` |
| **SMS** | Yes — no-show without fee (below) |
| **Notes** | Sets `no_show_strike = true`. No Stripe charge. Cal booking unchanged. |

```
Sadie Marie: You were marked as a no-show for your 2 Week Fill on Saturday, July 25 at 10:00am. Please reach out if you'd like to rebook. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 15. Admin marks no-show — charge 50%

| | |
|---|---|
| **Who** | Admin |
| **Status** | `no-show` |
| **SMS** | Yes — no-show with fee (below) |
| **Notes** | Amount = 50% of matched `site_services` price. Example `$65` = 50% of `$130`. Status is **not** updated if Stripe fails. `no_show_strike = false`. |

```
Sadie Marie: You were marked as a no-show for your 2 Week Fill on Saturday, July 25 at 10:00am. A no-show fee of $65 was charged to your card on file. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 16. Admin reschedule from dashboard

| | |
|---|---|
| **Who** | Admin |
| **Status** | `confirmed` |
| **SMS** | Yes — same reschedule text as client |
| **Notes** | Deduped if Cal `BOOKING_RESCHEDULED` webhook also fires. |

```
Sadie Marie: Your 2 Week Fill has been rescheduled to Sunday, July 26 at 2:00pm. Manage, reschedule, or cancel: https://www.sadiemarie.co/manage.html?uid=jAUwov2YZ7jjfo1QrVUYAA. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 17. Admin PATCH other status (e.g. phone cancel → `canceled_by_client`)

| | |
|---|---|
| **Who** | Admin (API; limited UI) |
| **Status** | varies |
| **SMS** | none |
| **Notes** | Local DB only. No Cal sync, no fee, no SMS. |

---

## Reminders (scheduled after confirm)

### 18. 24h reminder — lash / fill services

| | |
|---|---|
| **Who** | System (QStash → `/api/remind`) |
| **Status gate** | Must still be `confirmed` |
| **SMS** | Yes (below) |
| **Notes** | **No manage link** by design. |

```
Sadie Marie: Reminder — your 2 Week Fill is tomorrow at 10:00am. Please arrive with clean lashes and no eye makeup. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 19. 24h reminder — brow services

| | |
|---|---|
| **Who** | System (QStash) |
| **Status gate** | Must still be `confirmed` |
| **SMS** | Yes (below) |
| **Notes** | Same timing; arrival hint changes for brows. |

```
Sadie Marie: Reminder — your Brow Lamination is tomorrow at 10:00am. Please arrive with clean brows and no makeup. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 20. 1h reminder — lash / fill services

| | |
|---|---|
| **Who** | System (QStash) |
| **Status gate** | Must still be `confirmed` |
| **SMS** | Yes (below) |
| **Notes** | **No manage link** by design. |

```
Sadie Marie: Your 2 Week Fill is in one hour. Please arrive with clean lashes and no eye makeup. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 21. 1h reminder — brow services

| | |
|---|---|
| **Who** | System (QStash) |
| **Status gate** | Must still be `confirmed` |
| **SMS** | Yes (below) |

```
Sadie Marie: Your Brow Lamination is in one hour. Please arrive with clean brows and no makeup. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 22. 1h reminder — other services

| | |
|---|---|
| **Who** | System (QStash) |
| **Status gate** | Must still be `confirmed` |
| **SMS** | Yes (below) |

```
Sadie Marie: Your Consultation is in one hour. Please arrive a few minutes early. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
```

### 23. Reminder emails (lead + 1h)

| | |
|---|---|
| **Who** | System (QStash + Resend) |
| **Status gate** | Must still be `confirmed` |
| **SMS** | none |
| **Notes** | Email only (not SMS). Lead: ~48h brows / ~24h lashes; plus 1h before. |

### 24. App booking confirmation email

| | |
|---|---|
| **Who** | n/a |
| **SMS** | none |
| **Notes** | `sendBookingConfirmationEmail` exists in code but is **never called**. No app confirmation email today. |

---

## Other

### 25. Studio time block create or delete

| | |
|---|---|
| **Who** | Admin |
| **Status** | n/a (`studio_time_blocks`) |
| **SMS** | none |
| **Notes** | Blocks availability. Not a client appointment. |

### 26. Service payment / Stripe Terminal charge

| | |
|---|---|
| **Who** | n/a |
| **SMS** | none |
| **Notes** | Not built yet. Checkout only vaults a card for future fees. |

---

## Quick index — SMS vs none

| # | Scenario | Studio SMS |
|---|----------|------------|
| 1 | Public book → hold | **none** |
| 2 | Checkout confirm | confirmation |
| 3 | Admin manual booking | confirmation |
| 4 | `BOOKING_REQUESTED` | **none** |
| 5 | `BOOKING_CREATED` | **none** |
| 6 | Abandoned hold | **none** |
| 7 | Client cancel (on time, manage) | **none** |
| 8 | Client cancel (on time, Cal) | **none** |
| 9 | Client late cancel + $20 charged | late-cancel fee receipt |
| 10 | Client late cancel, charge fails | **none** |
| 11 | Client cancel after start | **none** |
| 12 | Client reschedule | reschedule |
| 13 | Admin cancel | admin cancel |
| 14 | Admin no-show, no charge | no-show (no fee) |
| 15 | Admin no-show, charge 50% | no-show (with fee) |
| 16 | Admin reschedule | reschedule |
| 17 | Admin other status PATCH | **none** |
| 18–22 | Reminder SMS variants | reminder |
| 23 | Reminder emails | **none** (email) |
| 24 | App confirmation email | **none** |
| 25 | Time blocks | **none** |
| 26 | Terminal / service charge | **none** |

---

## Related code

| Concern | File |
|---------|------|
| SMS copy | `lib/sms-appointment-copy.js` |
| Send + schedule | `lib/booking-notifications.js` |
| Confirm path | `app/api/booking/confirm/route.ts` |
| Admin status (cancel / no-show) | `app/api/admin/appointments/[id]/status/route.ts` |
| Admin reschedule | `app/api/admin/appointments/[id]/reschedule/route.ts` |
| Webhook (cancel / reschedule / late fee) | `lib/legacy-handlers/webhook.js` |
| Reminder delivery | `lib/legacy-handlers/remind.js` |
| A2P notes | `docs/a2p-sms-compliance.md` |
