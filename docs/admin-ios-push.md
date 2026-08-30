# Admin iOS new-booking push (APNs)

Always-on alerts when an appointment becomes **`confirmed`** in Postgres (the same moment it appears on the calendar). Holds (`pending`) do **not** notify.

There is no in-app mute. While a Clerk session is active, the iOS app requests notification permission, registers the APNs token, and re-registers on every foreground. The token is removed only on **Log Out**.

## What you must do in Apple + Vercel (cannot be done from code)

1. [Apple Developer](https://developer.apple.com/account) → **Keys** → **Apple Push Notification service (Key)** → create a key, download the `.p8`, note the **Key ID**.
2. Enable **Push Notifications** on both App IDs:
   - `com.lj-buchmiller.SadieMarie` (TestFlight / App Store)
   - `com.lj-buchmiller.SadieMarie.dev` (Xcode Debug)
3. In Vercel → Project → **Settings → Environment Variables**, set these on **Production and Preview** (and pull locally with `vercel env pull .env.local`):

| Name | Value |
| ---- | ----- |
| `APNS_KEY_ID` | 10-character key id from the APNs auth key |
| `APNS_TEAM_ID` | `F54JWSP8S3` |
| `APNS_P8` | Full `.p8` PEM (`-----BEGIN PRIVATE KEY-----` …) or the base64 body with `\n` escapes |

The iOS app POSTs tokens to `https://www.sadiemarie.co/api/admin/push-devices`. Debug builds send `environment=development` (Apple sandbox); Release/TestFlight send `environment=production`.

## Honesty about delivery

APNs cannot fire if the phone is off, has no network, or **iPhone Settings → Notifications** is denied. The Bookings tab shows a persistent banner with an Open Settings button when authorization is not `.authorized`.

The Simulator never receives real APNs. First proof is a **device / TestFlight** build with Release `aps-environment=production`.

## Backend map

- Schema: `scripts/add_admin_push_devices.sql` + `scripts/run-admin-push-devices-migration.mjs`
- Register / logout: `POST` / `DELETE` `/api/admin/push-devices`
- Send: `lib/admin-booking-push.js` from `notifyBookingConfirmed` (website checkout, Stripe recovery, admin New booking)
- Dedupe: `webhook_events.booking_uid` = `{calBookingUid}:admin_push`
- Apple 5xx retry: QStash → `/api/qstash/admin-booking-push`
