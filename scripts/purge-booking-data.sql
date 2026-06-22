-- ──────────────────────────────────────────────────────────────────────────
-- scripts/purge-booking-data.sql
--
-- Removes all client-booking CRM data while preserving admin/CMS tables:
--   • site_services, site_images, studio_settings, google_reviews
--
-- Deletes:
--   • webhook_events   (SMS/email idempotency keys)
--   • appointments     (Cal.com booking rows + Stripe refs)
--   • client_photos    (admin gallery blobs — DB rows only; see runner note)
--   • client_notes     (admin CRM notes)
--   • client_intake_forms (consent answers + stamped PDF URLs)
--   • clients          (CRM directory)
--
-- Does NOT delete Vercel Blob objects referenced by client_photos or
-- client_intake_forms.stamped_pdf_url — purge those separately if needed.
-- ──────────────────────────────────────────────────────────────────────────

TRUNCATE TABLE
  webhook_events,
  appointments,
  client_photos,
  client_notes,
  client_intake_forms,
  clients
RESTART IDENTITY CASCADE;
