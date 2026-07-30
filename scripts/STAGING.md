# Staging environment runbook

Stay on **one Vercel project** + **one Neon project**. Production = `main` → `www.sadiemarie.co`. Staging = `staging` git branch → `staging.sadiemarie.co` + Neon `staging` DB branch.

## Access model

- On `staging.sadiemarie.co`, **every** page requires a Clerk session for an allowlisted admin (`lib/admin-allowlist.ts`).
- Anyone else is **redirected to** `https://www.sadiemarie.co`.
- Use the **same Clerk application** as production. Add `https://staging.sadiemarie.co` to allowed origins / redirect URLs.
- Set the Clerk session cookie domain to **`.sadiemarie.co`** so signing into `/admin` on the live site also unlocks staging in the same browser.

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
| `DISABLE_OUTBOUND_SMS` | `true` |
| `POSTGRES_URL` | Neon **staging** branch URL only |
| `PUBLIC_BASE_URL` | `https://staging.sadiemarie.co` |
| `NEXT_PUBLIC_PUBLIC_BASE_URL` | `https://staging.sadiemarie.co` |
| Stripe keys | **test** (`sk_test_` / `pk_test_`) |
| Clerk keys | **same** app as production |
| `CRON_SECRET` | distinct from production |

Redeploy the `staging` branch after env changes.

### 4. Clerk

1. Add `https://staging.sadiemarie.co` to allowed origins / redirect URLs.
2. Session cookie domain: `.sadiemarie.co` (shared across www + staging).

## Day-to-day workflow

1. Build on a feature branch (optional Preview).
2. Merge into `staging` → auto-deploys to `https://staging.sadiemarie.co`.
3. Sign into live `/admin`, then open staging (or sign in on staging).
4. When happy, merge `staging` → `main` → production.

## Migrations

Prefer: migrate **production** first (or as part of the `main` deploy), then let Sunday reset (or a manual workflow run) refresh staging from production.

If `staging` git is ahead of `main` with new schema that production does not have yet, either promote to `main` soon or run the same migration against the staging `POSTGRES_URL` until promote.
