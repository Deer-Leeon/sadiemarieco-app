# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sadie Marie Beauty Studio (Lehi, UT) — a hybrid Next.js 16 / static-HTML site:
marketing site + client booking/consent flows + a Clerk-gated admin dashboard,
all on one Vercel deployment with a Neon Postgres database.

## Commands

```bash
npm install
npx vercel dev       # Next.js dev server + standalone /api/* Vercel Functions on :3000 (preferred — mirrors prod)
npm run next-dev     # Next-only dev loop, no /api/* functions
npm run build        # next build
npm run lint         # next lint
```

There is no test suite (`npm test` does not exist) — verify changes by running
the app and exercising the flow in the browser (`/loop`-style iteration won't
catch regressions here; use `vercel dev` and click through it).

### Database migrations

Each schema change is a `scripts/<name>.sql` file plus a one-shot
`scripts/run-<name>-migration.mjs` runner that uses `@vercel/postgres` (the
Neon serverless driver only accepts one statement per query, so runners split
the SQL into discrete statements and apply them with `IF NOT EXISTS` /
`DO $$ … $$` guards so they're idempotent and safe to re-run):

```bash
node --env-file=.env.local scripts/run-<name>-migration.mjs
```

Sync env vars from Vercel first if `.env.local` is stale: `vercel env pull .env.local`.

### Image processing

New photos in `assets/images/` need sRGB conversion (iPhone photos ship with
Display-P3 profiles that render washed out in Chrome; `sips --matchTo` can
corrupt them, so don't use it):

```bash
python3 -m venv .venv && .venv/bin/pip install Pillow   # one-time
.venv/bin/python scripts/convert_to_srgb.py
```

## Architecture

### Three rendering surfaces, one deployment

1. **`/` (homepage)** — `app/route.ts`, a Next.js *route handler* (not a page
   component). It reads `public/index.html` from disk verbatim and does two
   targeted string-substitution CMS injections before returning it:
   `<img data-image-id="X">` → latest Vercel Blob URL from `site_images`, and
   the `<!-- INJECT_SERVICES_HTML -->` token → a server-rendered services
   catalogue from `site_services`. This exists because the 500+ line static
   HTML has a fully-wired Cal.com booking drawer, FAQ accordion, and scroll
   animations (`public/js/main.js` + `public/css/styles.css`) that would be a
   high-regression-risk rewrite to port to JSX. `force-dynamic` + `no-store`
   so admin edits (image uploads, service changes) appear without a redeploy.
2. **`/manage` and `/consent/[clientId]`** — client-facing flows.
   `manage.html` (static, rewritten from `/manage` in `next.config.mjs`) is
   the magic-link appointment portal; `/consent/[clientId]` is a real Next.js
   page for the intake/consent form + e-signature + PDF stamping.
3. **`/admin/**`** — a real Next.js App Router tree, Clerk-gated, with direct
   `@vercel/postgres` access from Server Components.

Do not add a `/` rewrite in `next.config.mjs` — it would take precedence over
`app/route.ts` and serve the raw, pre-CMS-injection HTML.

### Auth (`proxy.ts`, not `middleware.ts`)

Next.js 16 renamed `middleware.ts` → `proxy.ts`. It wraps `clerkMiddleware`
and calls `auth.protect()` only for `/admin`, `/admin/:path*`,
`/api/admin/:path*`, and `/api/upload` (matcher in `proxy.ts`). Cron routes,
webhooks, and `/api/reviews` are deliberately excluded so their
Bearer/`X-Cron-Secret` headers are never parsed as Clerk JWTs.

The proxy only enforces "signed in." The actual allowlist
(`ALLOWED_ADMIN_EMAILS` — currently `lj.buchmiller@gmail.com` and
`mckenna@sadiemarie.co`) lives in `app/admin/auth.ts` (`getAdminAccess` /
`requireAdminUser`), and **every** privileged surface — Server Components and
`/api/admin/**` route handlers alike — must call it itself; the proxy matcher
is defence-in-depth, not the source of truth. `app/admin/page.tsx` keeps a
duplicate `ALLOWED_EMAILS` set as a second defence-in-depth check; keep both
in sync when adding/removing admins.

### Legacy Vercel Functions bridged into the App Router

Root-level `/api/*.js` Vercel Functions cannot coexist with `app/api/**` on
Vercel (both try to write `.vercel/output/functions/api`, causing an `EEXIST`
build failure). The original handlers (`booking`, `cancel-booking`, `webhook`,
`remind`, `feedback`) were moved to `lib/legacy-handlers/*.js` (CommonJS,
`(req, res)`-style) and are mounted via thin `app/api/<name>/route.js`
wrappers using `lib/adapt-vercel-handler.js`'s `toNextHandler`, which adapts
the Web `Request`/`Response` App Router contract to the old Node handler
signature. Don't "modernize" these into route handlers casually — they
encode the Cal.com webhook dispatch (booking created/cancelled/rescheduled →
client+appointment upsert, Twilio SMS, QStash scheduling) and changing the
bridge risks breaking idempotency (`webhook_events` table) and SMS timing.

Some `lib/*.js` modules (`booking-notifications.js`, `client-upsert.js`,
`client-phone.js`, `client-email.js`) are CommonJS implementations with thin
`.ts` wrappers (`booking-notifications.ts`, `client-upsert.ts`) that
`require()` them and re-export typed signatures — a deliberate bridge so
TypeScript call sites get types without porting the implementation.

### Booking lifecycle (Cal.com ↔ Postgres ↔ Stripe ↔ Twilio/QStash)

The booking flow spans several systems and is intentionally ordered for
idempotency and graceful degradation:

1. Client books via the Cal.com embed on the public site →
   `POST /api/booking/init` upserts a `pending` `appointments` row
   (idempotent on `cal_event_id`/booking UID; client upserted **by phone**,
   the canonical CRM identifier — see `lib/client-identity.ts` /
   `lib/client-upsert.ts`).
2. Client reaches `/checkout` (`app/checkout/`), which has an
   `CHECKOUT_HOLD_MINUTES` (8 min, `lib/booking-hold.ts`) countdown — read via
   `GET /api/booking/hold`. `app/api/cron/cleanup-abandoned` cancels expired
   holds on Cal and flips status.
3. `POST /api/booking/confirm` runs after Stripe's `confirmSetup()`: verifies
   the SetupIntent, attaches the vaulted PaymentMethod to the Stripe
   Customer (for future no-show/late-cancel off-session charges — see
   `lib/no-show-charge.ts` / `lib/late-cancel-charge.js`), writes
   `stripe_customer_id` to Postgres, **then** accepts the booking on Cal
   (v1 PATCH, falling back to v2 confirm). Order matters: Postgres is the
   source of truth and a Cal hiccup must never block card vaulting.
4. `POST /api/webhook` (legacy handler) receives Cal.com's
   `BOOKING_CREATED`/`BOOKING_CANCELLED`/`BOOKING_RESCHEDULED`/
   `BOOKING_REQUESTED` events, dedupes via `webhook_events`, and dispatches
   Twilio SMS confirmations + schedules `/api/remind` (24h reminder) and
   `/api/feedback` (24h follow-up) through Upstash QStash.

When changing any piece of this chain, trace forward through all four steps —
each assumes idempotency and ordering guarantees the others rely on.

### Cal.com as the services source of truth

`site_services` (Postgres) mirrors Cal.com event types. `app/admin/services/sync.ts`
(`reconcileWithCal`) is the single reconciliation utility called from three
places — the public homepage (`app/route.ts`, 60s TTL-cached so high traffic
doesn't spam Cal's API), `/admin/services` (force-refreshed, editors expect
instant feedback), and the `/api/admin/services` CRUD route. If you add a new
read path for `site_services`, call `reconcileWithCal()` from it too or
orphaned/deleted-in-Cal services will linger in the local DB.

`lib/cal-config.ts` centralizes Cal.com tuning constants (slot intervals,
booking notice, the hidden "admin override" event type used for manual
bookings outside normal availability) — consult it before hardcoding
Cal-related numbers elsewhere.

### Consent / intake flow

`/consent/[clientId]` (public, UUID-keyed) collects intake answers + an
e-signature (`SignaturePad.tsx`), previews the result
(`ConsentPreviewStep.tsx` + PDF.js), then `lib/pdf-stamper.ts` flattens the
answers and signature onto the studio's PDF template (uploaded via
`/admin/settings`, stored as a `studio_settings` singleton row), uploads the
result to Vercel Blob, and stores the URL on `client_intake_forms`. Field
mapping is an explicit hardcoded registry against the Sejda-generated
AcroForm field names — see the long git history of `pdf-stamper.ts` fixes
(checkbox appearances, flatten-then-draw ordering, font embedding) before
changing it; the stamping pipeline is fragile to get exactly right and most
prior bugs were ordering issues (draw fields *after* flatten, embed EB
Garamond statically, etc).

### Admin dashboard structure

`app/admin/page.tsx` is the Server Component entry; `DashboardUI.tsx` is the
client shell switching between `CalendarView`/`ListView`/`AppointmentListRow`.
Sub-areas under `app/admin/`: `clients/` (CRM directory + notes/history +
photos), `services/` (catalogue editor synced to Cal), `availability/`
(Cal schedule editor), `settings/` (consent PDF template upload), `website/`
(CMS image uploads via `ImageUploader.tsx` → `site_images`), and
`components/` (manual-booking modal/slot-picker — admin-only bookings that
bypass the public Cal availability via the "admin override" event type in
`lib/cal-config.ts`).

### Cron & background jobs

Routes under `app/api/cron/**` (review sync, abandoned-checkout cleanup) are
gated by `lib/cron-auth.ts`'s `rejectUnlessCronAuthorized`, which accepts
`Authorization: Bearer`, `X-Cron-Secret`, or `?cron_secret=` (in that
priority order — the header form survives the apex→www redirect that strips
query strings on `curl -L`). These are excluded from the Clerk proxy matcher.

## Twilio A2P 10DLC / SMS compliance

Transactional appointment SMS is regulated. **Do not** make the booking
`sms-consent` checkbox required, imply that providing a phone number opts
someone into texts, or weaken the Privacy Policy mobile non-sharing
statement. Full rules, file map, Twilio `message_flow` paste text, and a
pre-ship checklist live in:

[`docs/a2p-sms-compliance.md`](docs/a2p-sms-compliance.md)

After changing Cal booking fields, backfill every event type:

```bash
node --env-file=.env.local scripts/backfill-cal-event-studio-defaults.mjs
```

## Styling

Tailwind v4 (`@theme`/`@custom-variant` in `app/globals.css`, no separate
config needed for the admin's shadcn components — `tailwind.config.ts` only
exists to extend `content` globs to `public/js/**/*.js` for the
Tailwind-powered review widgets in `public/css/reviews-tailwind.*`). The
public marketing site (`public/index.html` / `public/css/styles.css`) is
plain hand-written CSS with custom properties — a completely separate styling
system from the admin's shadcn/Tailwind stack. Don't mix them.

shadcn config: `components.json` (style `new-york`, baseColor `neutral`,
aliases `@/components`, `@/lib`, `@/components/ui`).

## Git workflow

Commit and push to GitHub regularly as you work — after each coherent, working
change, not just at the end of a session. This is solo-maintained and
deployed straight from the repo, so uncommitted/unpushed work is the single
biggest risk of losing status or progress. Write clean, focused commit
messages that describe the "why" (matches the existing log style — see
`git log`, e.g. "Fix manual booking slots mis-bucketed across month
boundaries", "Sync intake form and PDF stamper to redesigned consent
layout"). Avoid bundling unrelated changes into one commit, and avoid vague
messages like "wip" or "updates".

## Required environment variables

See `.env.local` for the full list (Clerk, Cal.com, Twilio, Stripe, Postgres,
Upstash QStash, Vercel Blob, Google Places/Reviews, cron secret). Pull fresh
values with `vercel env pull .env.local` after adding new ones in the Vercel
dashboard — missing vars typically surface as runtime 500s, not build
failures, since most routes are `force-dynamic`.
