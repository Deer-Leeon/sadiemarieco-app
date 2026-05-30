# Sadie Marie Beauty Studio

Editorial-magazine-inspired site for **Sadie Marie — Luxury Beauty Studio** in
Lehi, Utah. Hybrid architecture: static HTML/CSS/JS marketing site + magic-link
booking portal, with a Clerk-protected Next.js admin dashboard layered on top.
All real-time integration (Cal.com webhooks, Twilio SMS, QStash scheduling)
runs through standalone Vercel Functions in `/api/`.

## Features

- Magazine-cover hero section with editorial typography
- Services and pricing in a multi-column newspaper layout
- About section with overlapping image and quote treatment
- Portfolio collage with hover interactions
- Studio policies in a clean three-column grid
- Contact form and FAQ accordion
- Fully responsive across mobile, tablet, and desktop
- Smooth scroll-reveal animations powered by `IntersectionObserver`

## Project Structure

This is a hybrid project: the marketing site (`index.html`) and the client-facing
booking portal (`manage.html`) remain pure static HTML served from `/public`,
while the protected `/admin` dashboard is a Next.js App Router page rendered
server-side with Clerk auth. Both run on the same Vercel deployment.

```
.
├── app/
│   ├── layout.tsx          # Root layout, wraps everything in ClerkProvider
│   ├── globals.css         # Tailwind v4 + shadcn theme tokens (light + dark)
│   └── admin/
│       └── page.tsx        # /admin — Clerk-gated bookings dashboard
├── components/
│   └── ui/                 # shadcn-style primitives (badge, card, table)
├── lib/
│   └── utils.ts            # cn() helper for tailwind class merging
├── middleware.ts           # Clerk auth guard scoped to /admin only
├── next.config.mjs         # Rewrites / → /index.html, /manage → /manage.html
├── public/                 # Static assets served as-is
│   ├── index.html          # The marketing site (served at /)
│   ├── manage.html         # Magic-link appointment management portal
│   ├── css/
│   │   └── styles.css      # All static-site styles
│   ├── js/
│   │   ├── main.js         # Nav scroll, reveal animations, FAQ, booking drawer
│   │   └── manage.js       # Portal client: fetch, render, reschedule, cancel
│   └── assets/images/      # All site images
├── api/                    # Vercel Serverless Functions (CommonJS, untouched
│   │                       #   by the Next.js build — deployed as standalone
│   │                       #   functions alongside the Next app)
│   ├── booking.js          # GET  /api/booking?uid=...        — Cal v2 read proxy
│   ├── cancel-booking.js   # POST /api/cancel-booking         — Cal cancel + DB
│   ├── webhook.js          # POST /api/webhook                — Cal webhook dispatch
│   │                       #   (BOOKING_CREATED → upsert + SMS + QStash schedule;
│   │                       #    BOOKING_CANCELLED → status flip)
│   ├── remind.js           # POST /api/remind                 — QStash 24h reminder
│   └── feedback.js         # POST /api/feedback               — QStash 24h follow-up
├── components.json         # shadcn config (style: new-york, neutral)
├── tsconfig.json
├── postcss.config.mjs
├── package.json
└── README.md
```

### Why static HTML + Next.js coexist

The original marketing site and booking portal predate the admin dashboard and
are battle-tested. Re-implementing them as React Server Components would risk
regressing the Cal.com embed flow in `manage.js`, the reveal animations in
`main.js`, and the existing booking-confirmation iframe lifecycle. Instead:

- `/` and `/manage.html` are served verbatim from `public/` (next.config.mjs
  rewrites `/` to `/public/index.html` since Next.js doesn't do that on its own).
- `/admin` is a real Next.js App Router page so we get React Server Components,
  Clerk middleware integration, and direct `@vercel/postgres` calls inside the
  server render.
- Root-level `/api/*.js` files keep deploying as standalone Vercel Functions
  (Vercel supports this hybrid model — Next.js routes coexist with vanilla
  serverless functions in the same project).

## Appointment Management Portal

Clients receive a magic link in their Cal.com confirmation email of the form:

```
https://sadiemarie.co/manage.html?uid=<bookingUid>
```

The portal lets them view, reschedule (via an inline Cal.com embed), or cancel
their appointment without creating an account. All Cal.com API calls are made
from Vercel Serverless Functions in `/api/` so the Cal API key never reaches
the browser.

## Admin Dashboard (`/admin`)

A Clerk-protected dashboard showing the latest 50 appointments from the Neon
Postgres database. Access is restricted to a hardcoded email allowlist in
`app/admin/page.tsx`:

```ts
const ALLOWED_EMAILS = new Set([
  'lj.buchmiller@gmail.com',
  'mcmarie27@gmail.com',
]);
```

Flow when an unauthenticated user hits `/admin`:

1. `middleware.ts` runs (matcher: `/admin`, `/admin/:path*`)
2. Clerk redirects to its hosted sign-in URL
3. On successful sign-in, the user lands on `/admin`
4. The server component checks the user's linked emails against the allowlist
5. Non-matching users are `redirect('/')`ed silently (no 403 page leaks the
   existence of the dashboard)

To add/remove admins, edit the `ALLOWED_EMAILS` set and redeploy.

## Required environment variables

Set all of these in Vercel under **Project → Settings → Environment Variables**
(Production, Preview, and Development unless noted). After adding, run
`vercel env pull .env.local` to sync them locally.

### Cal.com (booking + cancel proxies)

| Name          | Value                            |
| ------------- | -------------------------------- |
| `CAL_API_KEY` | A Cal.com API key (`cal_live_…`) |

### Twilio (SMS confirmations + reminders + follow-ups)

| Name                  | Value                                  |
| --------------------- | -------------------------------------- |
| `TWILIO_ACCOUNT_SID`  | Twilio account SID                     |
| `TWILIO_AUTH_TOKEN`   | Twilio auth token                      |
| `TWILIO_PHONE_NUMBER` | The Twilio number SMS is sent **from** |

### Postgres (data + idempotency + admin dashboard)

| Name           | Value                                                          |
| -------------- | -------------------------------------------------------------- |
| `POSTGRES_URL` | Auto-populated when you connect a Neon/Vercel Postgres DB      |

Required tables / columns (see migration notes below):

```sql
CREATE TABLE clients (
  id SERIAL PRIMARY KEY,
  first_name TEXT,
  last_name  TEXT,
  email      TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE appointments (
  id SERIAL PRIMARY KEY,
  client_id INT REFERENCES clients(id),
  service_name TEXT,
  booking_time TIMESTAMPTZ,
  cal_event_id TEXT UNIQUE NOT NULL,
  client_first_name TEXT,
  client_last_name TEXT,
  client_email TEXT,
  client_phone TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed'
);

CREATE TABLE webhook_events (
  id SERIAL PRIMARY KEY,
  booking_uid TEXT UNIQUE NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Upstash QStash (24h reminder + 24h follow-up scheduling)

| Name                          | Value                                       |
| ----------------------------- | ------------------------------------------- |
| `QSTASH_TOKEN`                | Publish credential from Upstash console     |
| `QSTASH_CURRENT_SIGNING_KEY`  | Signature-verification key                  |
| `QSTASH_NEXT_SIGNING_KEY`     | For zero-downtime key rotation (recommended)|

### Clerk (admin auth)

| Name                                 | Value                          |
| ------------------------------------ | ------------------------------ |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`  | Clerk publishable key          |
| `CLERK_SECRET_KEY`                   | Clerk secret key (server-only) |

Optional — only set if you self-host the sign-in pages:

| Name                              | Value                          |
| --------------------------------- | ------------------------------ |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`   | `/sign-in` (if hosted in-app)  |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL`   | `/sign-up` (if hosted in-app)  |

### Client consent / intake form

Internal form at **`/consent/[clientId]`** (public). Answers live in `client_intake_forms` (`scripts/create_client_intake_forms.sql`). API: `GET` / `POST` `/api/consent/[clientId]`.

| Name              | Value                                              |
| ----------------- | -------------------------------------------------- |
| `PUBLIC_BASE_URL` | Base URL for intake links in SMS (e.g. `https://www.sadiemarie.co`) |

### Optional

| Name              | Value                                              |
| ----------------- | -------------------------------------------------- |
| `PUBLIC_BASE_URL` | Override for the prod URL used in SMS links / QStash callback URLs |

## Local development

```bash
npm install
npx vercel dev
```

`vercel dev` runs the Next.js dev server AND the standalone `/api/*` Vercel
Functions on a single port (default 3000). For a Next-only dev loop without
the API functions, run `npm run next-dev` instead.

| URL                                                | What it serves          |
| -------------------------------------------------- | ----------------------- |
| <http://localhost:3000>                            | `public/index.html`     |
| <http://localhost:3000/manage.html?uid=…>          | `public/manage.html`    |
| <http://localhost:3000/admin>                      | Clerk-gated dashboard   |
| `POST http://localhost:3000/api/webhook` etc.      | Vercel Functions        |

### Configuring Cal.com to send the magic link

In Cal.com, open **Event Type → Workflows** (or Booking Questions / email
template) and add a custom link to the confirmation/reminder emails:

```
{{BOOKING_UID_LINK_URL}}                ← built-in Cal variable; or:
https://sadiemarie.co/manage.html?uid={{BOOKING_UID}}
```

Cal will substitute `{{BOOKING_UID}}` at send time.

## Image Assets

Place your images in `assets/images/` using these exact filenames (lowercase, no spaces — important because Vercel runs on case-sensitive Linux):

| File                                  | Used in section      | Suggested source                 |
| ------------------------------------- | -------------------- | -------------------------------- |
| `assets/images/hero1.jpg`             | Hero                 | Your "Hero Picture" photo        |
| `assets/images/mckenna1.jpeg`         | About                | Your "McKenna" photo             |
| `assets/images/addy1.jpeg`            | Portfolio (Classic Lashes) | Your "Addy" photo          |
| `assets/images/glow-facial.jpg`       | Portfolio (Glow Facial)     | Replace with your own photo |
| `assets/images/brow-lamination.jpg`   | Portfolio (Brow Lamination) | Replace with your own photo |
| `assets/images/volume-set.jpg`        | Portfolio (Volume Set)      | Replace with your own photo |
| `assets/images/skin-treatment.jpg`    | Portfolio (Skin Treatment)  | Replace with your own photo |

> **Tip:** Optimize images to ~1600px on the longest edge and compress them (e.g., with [Squoosh](https://squoosh.app/)) for fast load times.

### Important: convert iPhone photos to sRGB before adding them

Photos straight from an iPhone are saved with an embedded **Display P3** color profile. Safari color-manages this correctly, but Chrome and most other browsers render P3 images inconsistently — typically washed out or over-exposed. To keep colors identical across every browser and device, convert any new photo to standard **sRGB** before committing it.

This repo ships with a small Python helper (`scripts/convert_to_srgb.py`) that uses Pillow's ICC color-management to do the conversion safely. macOS's built-in `sips --matchTo` can silently corrupt some iPhone JPEGs into all-black images, so we avoid it.

**One-time setup** (creates a local virtual environment for the script):

```bash
python3 -m venv .venv
.venv/bin/pip install Pillow
```

**Convert any photos you add to `assets/images/`:**

```bash
.venv/bin/python scripts/convert_to_srgb.py
```

The script will process every `.jpg`/`.jpeg` in `assets/images/`, detect its source profile, convert the pixel data to sRGB, and re-save at JPEG quality 90 with the sRGB profile embedded. Verify any individual file with:

```bash
sips -g profile assets/images/your-photo.jpeg
# Should print:  profile: sRGB IEC61966-2.1
```

## Deploy to Vercel

Vercel auto-detects Next.js from `package.json` and runs `next build`. The
standalone `/api/*` functions are deployed as separate Vercel Functions
alongside the Next.js app — no extra configuration required.

```bash
npm i -g vercel
vercel        # Preview deploy
vercel --prod # Production deploy
```

Make sure all environment variables in the table above are set in Vercel
**before** deploying (otherwise the admin dashboard build will succeed but the
runtime will fail on first request).

## Browser Support

Tested in the latest versions of Chrome, Safari, Firefox, and Edge. Uses modern CSS (custom properties, Grid, `clamp()`) and a graceful fallback in `js/main.js` for browsers without `IntersectionObserver`.

## Customizing

- **Colors and typography:** Edit the CSS custom properties at the top of `css/styles.css` (`:root { ... }`).
- **Content:** Edit `index.html` directly — services, policies, FAQ, contact info, etc.
- **Behavior:** Tweak nav scroll threshold, reveal threshold, or accordion behavior in `js/main.js`.

## License

© Sadie Marie Beauty Studio. All rights reserved.
