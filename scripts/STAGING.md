# Staging environment runbook

Stay on **one Vercel project** + **one Neon project**. Production = `main` → `www.sadiemarie.co`. Staging = `staging` git branch → `staging.sadiemarie.co` + Neon `staging` DB branch.

## Access model

- On `staging.sadiemarie.co`, marketing pages require an allowlisted admin session; everyone else is **redirected to** `https://www.sadiemarie.co`.
- `/admin` works like live: unsigned → staging `/sign-in` → allowlisted admins reach the dashboard (`lib/admin-allowlist.ts`).
- Use the **same Clerk Production application** (same `pk_live_` / `sk_live_`) as live.
- Clerk does **not** share `__session` across subdomains — sign in again on staging (same users/passwords).

Outbound Twilio SMS is **disabled** on staging / preview (`lib/outbound-sms-allowed.js`). Do not point Cal.com production webhooks at staging.

## One-time console setup

### 1. Neon

1. Open the Neon project used by production.
2. Create a branch named **`staging`** from the production/default branch (current data).
3. Copy the staging branch connection string → Vercel env `POSTGRES_URL` for the staging branch only.
4. Note IDs for GitHub secrets:
   - `NEON_PROJECT_ID`
   - `NEON_STAGING_BRANCH_ID` (branch id `br-…`)
   - `NEON_PRODUCTION_BRANCH_ID` (parent `br-…`)
5. Create an API key → `NEON_API_KEY`.
6. Enable **scheduled snapshots** / a longer **instant restore history window** on production (real disaster recovery). The weekly staging reset is a refresh + secondary copy, not a substitute for Neon backups.

### 2. GitHub

Create branch `staging` from `main` and push it:

```bash
git checkout main
git pull
git checkout -b staging
git push -u origin staging
```

Add repository secrets (Settings → Secrets → Actions):

| Secret | Value |
| --- | --- |
| `NEON_API_KEY` | Neon API key |
| `NEON_PROJECT_ID` | Neon project id |
| `NEON_STAGING_BRANCH_ID` | Staging branch id |
| `NEON_PRODUCTION_BRANCH_ID` | Production/parent branch id |

Workflow: [`.github/workflows/sync-staging-db.yml`](../.github/workflows/sync-staging-db.yml) runs every Sunday 14:00 UTC (08:00 America/Denver) and can be run manually via **Actions → Sync staging database → Run workflow**.

Manual local reset:

```bash
node --env-file=.env.local scripts/reset-staging-neon.mjs
```

### 3. Vercel

1. **Domains:** add `staging.sadiemarie.co`, assign to git branch **`staging`** (not Production).
2. **DNS:** CNAME `staging` → Vercel (as shown in the Domains UI).
3. **Environment variables** for the `staging` branch (Preview + Git Branch `staging`, or Custom Environment `staging` on Pro). Keep Production values unchanged.

| Variable | Staging value |
| --- | --- |
| `APP_ENV` | `staging` |
| `DISABLE_OUTBOUND_SMS` | optional hard-kill; staging uses the **Settings → Outbound SMS** toggle instead |
| `POSTGRES_URL` | Neon **staging** branch URL only |
| `PUBLIC_BASE_URL` | `https://staging.sadiemarie.co` |
| `NEXT_PUBLIC_PUBLIC_BASE_URL` | `https://staging.sadiemarie.co` |
| Stripe keys | **test** (`sk_test_` / `pk_test_`) — never live keys on staging |
| Clerk keys | **same** app as production |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | **same as production** (otherwise Settings toggle cannot send) |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | **same as production** (consent + reminder emails) |
| `CRON_SECRET` | distinct from production |

**Staging SMS:** Off by default. Enable from `/admin/settings` → **Outbound SMS** (staging only). Uses the real Twilio number; ~1¢/message. Sunday Neon reset clears the toggle back to off. Twilio/Resend must exist on the Vercel **Preview (staging)** env — Production-only secrets are not inherited.

**Stripe split (important):**

| Host | Stripe mode | Keys |
| --- | --- | --- |
| `www.sadiemarie.co` (Production) | **Live** | `sk_live_` + `pk_live_` |
| `staging.sadiemarie.co` | **Test** | `sk_test_` + `pk_test_` |

Live mode rejects Stripe test card numbers and only accepts real cards. Test mode never charges real cards. After changing keys, redeploy that environment (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is baked at build time). Confirm on each host via `/admin/health` → “Stripe key mode (live vs test)”.

Redeploy the `staging` branch after env changes.

### 4. Clerk

1. Add `https://staging.sadiemarie.co` to allowed origins / redirect URLs (Configure → Domains / Paths as shown in the Clerk UI).
2. Confirm Preview/`staging` Vercel env uses the **same** Production `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`.

## Day-to-day workflow

1. Build on a feature branch (optional Preview).
2. Merge into `staging` → auto-deploys to `https://staging.sadiemarie.co`.
3. Open `https://staging.sadiemarie.co/admin`, sign in with an allowlisted admin (same Clerk users as live; live session does not carry over).
4. When happy, merge `staging` → `main` → production.

## Migrations

Prefer: migrate **production** first (or as part of the `main` deploy), then let Sunday reset (or a manual workflow run) refresh staging from production.

If `staging` git is ahead of `main` with new schema that production does not have yet, either promote to `main` soon or run the same migration against the staging `POSTGRES_URL` until promote.
