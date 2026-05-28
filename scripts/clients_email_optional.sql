-- Make clients.email optional; phone remains the CRM unique identifier.
-- Safe to re-run: DROP NOT NULL is idempotent when already nullable.

ALTER TABLE clients ALTER COLUMN email DROP NOT NULL;
