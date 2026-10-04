/**
 * Add site_images photo columns on the production and staging Neon
 * branches. Uses the Neon API key already stored for the weekly
 * staging reset. Does not print connection strings.
 *
 *   NEON_API_KEY
 *   NEON_PROJECT_ID
 *   NEON_PRODUCTION_BRANCH_ID
 *   NEON_STAGING_BRANCH_ID
 */
import { spawnSync } from 'node:child_process';

const API_BASE = 'https://console.neon.tech/api/v2';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

function safe(text) {
  return String(text).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]');
}

async function neon(apiKey, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${safe(typeof body === 'string' ? body : JSON.stringify(body))}`);
  }
  return body;
}

async function connectionUri(apiKey, projectId, branchId) {
  const roles = await neon(
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/roles`
  );
  const roleNames = (roles.roles || []).map((role) => role.name).filter(Boolean);
  const roleName =
    roleNames.find((name) => name.endsWith('_owner')) || roleNames[0];
  if (!roleName) throw new Error('No database role on this branch');

  const databases = await neon(
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/databases`
  );
  const dbNames = (databases.databases || []).map((db) => db.name).filter(Boolean);
  const databaseName = dbNames.includes('neondb') ? 'neondb' : dbNames[0];
  if (!databaseName) throw new Error('No database on this branch');

  const params = new URLSearchParams({
    branch_id: branchId,
    database_name: databaseName,
    role_name: roleName,
    pooled: 'true',
  });
  const connection = await neon(
    apiKey,
    `/projects/${encodeURIComponent(projectId)}/connection_uri?${params}`
  );
  if (!connection?.uri) throw new Error('Neon did not return a connection URI');
  return { uri: connection.uri, roleName, databaseName };
}

function applySql(uri) {
  const result = spawnSync(
    process.execPath,
    ['scripts/run-add-site-images-alt-migration.mjs'],
    {
      env: { ...process.env, POSTGRES_URL: uri },
      encoding: 'utf8',
    }
  );
  if (result.stdout) process.stdout.write(safe(result.stdout));
  if (result.stderr) process.stderr.write(safe(result.stderr));
  if (result.status !== 0) {
    throw new Error(`migration exited ${result.status}`);
  }
}

async function migrateBranch(apiKey, projectId, label, branchId) {
  console.log(`[alt-columns] ${label}`);
  const { uri, roleName, databaseName } = await connectionUri(
    apiKey,
    projectId,
    branchId
  );
  console.log(`[alt-columns] ${label} database ${databaseName} role ${roleName}`);
  applySql(uri);
  console.log(`[alt-columns] ${label} ready`);
}

const apiKey = requireEnv('NEON_API_KEY');
const projectId = requireEnv('NEON_PROJECT_ID');
const productionBranchId = requireEnv('NEON_PRODUCTION_BRANCH_ID');
const stagingBranchId = requireEnv('NEON_STAGING_BRANCH_ID');

await migrateBranch(apiKey, projectId, 'production', productionBranchId);
await migrateBranch(apiKey, projectId, 'staging', stagingBranchId);
