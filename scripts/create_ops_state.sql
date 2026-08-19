-- Small operational key/value store:
--   • cron/job heartbeats (last successful run per job) so the admin
--     health check can flag a scheduler that silently stopped firing
--   • health-alert cooldown state for /api/cron/health-alert
CREATE TABLE IF NOT EXISTS ops_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
