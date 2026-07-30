/**
 * Reset the Neon `staging` branch from its parent (production).
 *
 * Uses Neon's restore API with source_branch_id = parent so staging
 * schema + data match production head. Connection string / endpoint
 * for the staging branch stay the same after reset.
 *
 * Required env:
 *   NEON_API_KEY
 *   NEON_PROJECT_ID
 *   NEON_STAGING_BRANCH_ID
 *   NEON_PRODUCTION_BRANCH_ID  (parent / source)
 *
 * Usage:
 *   node --env-file=.env.local scripts/reset-staging-neon.mjs
 */

const API_BASE = 'https://console.neon.tech/api/v2';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const apiKey = requireEnv('NEON_API_KEY');
  const projectId = requireEnv('NEON_PROJECT_ID');
  const stagingBranchId = requireEnv('NEON_STAGING_BRANCH_ID');
  const productionBranchId = requireEnv('NEON_PRODUCTION_BRANCH_ID');

  const url = `${API_BASE}/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(stagingBranchId)}/restore`;

  console.log('[reset-staging-neon] Resetting staging from production…', {
    projectId,
    stagingBranchId,
    productionBranchId,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source_branch_id: productionBranchId,
    }),
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    console.error('[reset-staging-neon] Neon API error', {
      status: res.status,
      body,
    });
    process.exit(1);
  }

  console.log('[reset-staging-neon] OK — staging now matches production head.', {
    status: res.status,
    branch: body?.branch?.name || body?.branch?.id || stagingBranchId,
  });
}

main().catch((err) => {
  console.error('[reset-staging-neon] failed', err);
  process.exit(1);
});
