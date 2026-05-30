-- studio_settings — singleton row for studio-wide configuration.
-- Run once against production Postgres (Neon / Vercel Postgres).
--
-- consent_pdf_url: public Vercel Blob URL for the global lash/brow
-- consent PDF template admins upload from /admin/settings.

CREATE TABLE IF NOT EXISTS studio_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  consent_pdf_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO studio_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
