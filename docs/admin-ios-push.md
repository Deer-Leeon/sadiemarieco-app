# Admin iOS booking push (APNs)

Always-on alerts when a **confirmed** appointment is booked, rescheduled, or canceled. Holds (`pending`) and abandoned checkout (`canceled_by_system`) do **not** notify.

Copy depends on who made the change:

| Event | Who | Title | Body |
| ----- | --- | ----- | ---- |
| Confirmed | Client | New booking | `{name} booked {service} · {when}` |
| Confirmed | Admin | You scheduled a booking | `You scheduled {service} for {name} · {when}` |
| Rescheduled | Client | Booking rescheduled | `{name} rescheduled {service} · {when}` |
| Rescheduled | Admin | You rescheduled a booking | `You rescheduled {service} for {name} · {when}` |
| Canceled | Client | Booking canceled | `{name} canceled {service} · {when}` |
| Canceled | Admin | You canceled a booking | `You canceled {service} for {name} · {when}` |

`{when}` is Mountain time (same format as before, e.g. `Tue, Sep 2, 10:00 AM`). If the time is missing, the ` · {when}` suffix is omitted. `{name}` is the client's first + last name.

There is no in-app mute. Sign in once; stay signed in until **Log Out**. The app keeps the Clerk session warm and re-registers the APNs token on launch, every foreground, background fetch, and silent push. The token is removed only on **Log Out**.

## What you must do in Clerk (session must not expire)

App code cannot override Clerk’s session policy. In [Clerk Dashboard](https://dashboard.clerk.com) → **Configure → Sessions**:

1. **Session lifetime** — set to the longest value available (ideally a year, or no expiry).
2. **Inactivity timeout** — **disable** it (or set it as long as session lifetime).

If inactivity is left at Clerk’s default (often days), opening the app after a quiet week can dump you on the login screen. The device token usually still gets alerts until Apple rotates it; a live session is what lets the app refresh that token in the background.

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

APNs cannot fire if the phone is off, has no network, Focus/Deliver Quietly is silencing banners, or **iPhone Settings → Notifications** is denied. The Bookings tab shows a persistent banner with an Open Settings button when authorization is not `.authorized`.

If the phone is only briefly offline, Apple now **stores** the alert for up to **7 days** (`apns-expiration`) and delivers it when the device is reachable. Previously expiration was `0`, which discarded the alert immediately.

The Simulator never receives real APNs. First proof is a **device / TestFlight** build with Release `aps-environment=production`.

Confirmed-booking, reschedule, and cancel pushes include `content-available` so a backgrounded admin app can refetch the calendar immediately and refresh its session/token. With the app open on Bookings, the calendar also reloads when the banner arrives, when you return from another app, and about every 10 seconds while that tab is selected. Pending checkout holds still do not appear on the 3-day / week grids.

Booking alerts are sent with `interruption-level: time-sensitive` and the app carries the **Time Sensitive Notifications** entitlement (`SadieMarie.entitlements` / `SadieMarieRelease.entitlements`), so they break through Focus modes and scheduled summaries unless the admin explicitly turns Time Sensitive off for the app in iOS Settings. Xcode's automatic signing adds the capability to both App IDs on the next build; if signing complains, open **Signing & Capabilities** and add *Time Sensitive Notifications* once.

## Delivery guarantees

Vercel keeps roughly an hour of runtime logs, so "the banner never showed up" used to be unprovable after the fact. Every send now leaves a trail and every failure has a defined next step:

- **Delivery log** — `admin_push_deliveries` gets one row per APNs attempt (Apple status, reason, `apns-id`, token prefix) and one row per skip (`no_devices`, `missing_booking_uid`, `apns_not_configured`, …). Inspect it with:

  ```bash
  node --env-file=.env.local scripts/admin-push-audit.mjs            # last 14 days
  UID=<calBookingUid> node --env-file=.env.local scripts/admin-push-audit.mjs
  ```

- **Shared provider JWT** — the ES256 token lives in `admin_push_provider_token` and is reused by every serverless instance for 50 minutes. Apple returns `429 TooManyProviderTokenUpdates` when a key mints tokens more than once per 20 minutes; per-instance caches cannot honour that on Vercel. A `403 ExpiredProviderToken` / `InvalidProviderToken` re-signs once and retries inside the same request.
- **Retry chain** — anything that is not a hard rejection (timeouts, 429, 5xx) is re-queued through QStash → `/api/qstash/admin-booking-push` with delays 15s → 60s → 5m → 15m → 1h (6 attempts total). Tokens still failing after a partially successful retry are re-queued, not dropped. If no device is registered yet, the chain reloads devices on every attempt.
- **Dead tokens** — `410`, `BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic` delete the row; the app re-registers on its next foreground or silent push, and a reload-devices retry is queued so the alert still lands.
- **Claim release** — if nothing was sent *and* nothing could be queued, the `webhook_events` dedupe claim is released so the next lifecycle path (Cal webhook after checkout confirm, `/manage` cancel, admin PATCH) can send it.
- **Ordering** — in the Cal webhook the admin push runs before the Stripe penalty, extras cleanup, reminder emails and SMS, so a failure in any of those can no longer swallow the banner.

## Backend map

- Schema: `scripts/add_admin_push_devices.sql` + `scripts/run-admin-push-devices-migration.mjs`; delivery log + JWT cache: `scripts/add_admin_push_deliveries.sql` + `scripts/run-admin-push-deliveries-migration.mjs` (also created lazily by the sender)
- Register / logout: `POST` / `DELETE` `/api/admin/push-devices`
- Send: `lib/admin-booking-push.js` `notifyAdminAppointmentPush` — **production only**. Staging / Vercel preview do not send APNs. Cal.com webhooks hit `www`, so a booking made on staging already notifies from production; a second staging send was the duplicate “New booking” + “You scheduled a booking” pair.
  - Confirmed: `notifyBookingConfirmed` (website checkout, Stripe recovery, admin New booking)
  - Rescheduled: `notifyAppointmentRescheduled` (Cal webhook + admin reschedule)
  - Canceled: admin status PATCH + Cal `BOOKING_CANCELLED` (client cancel of a confirmed booking)
- Dedupe: `webhook_events.booking_uid` = `{calBookingUid}:admin_push` (confirmed) or `{calBookingUid}:admin_push:{kind}` (rescheduled / canceled)
- Collapse id: `{uid}:{kind}` (so a cancel banner does not replace a new-booking banner)
- Retry worker: QStash → `/api/qstash/admin-booking-push` (`lib/admin-booking-push.js` `runAdminPushRetry`; body carries `kind`, `source`, `attempt`, and either `tokens` or `reloadDevices`)
- Audit: `scripts/admin-push-audit.mjs` (read-only; never prints client names or phones)
- Debug (`Sadie Marie Dev`) and TestFlight/App Store (`Sadie Marie`) are separate bundle IDs. Both receive the same alert if both apps are installed and registered.
