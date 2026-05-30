-- Final flattened consent PDF (stamped from studio template + intake data).
ALTER TABLE client_intake_forms
  ADD COLUMN IF NOT EXISTS stamped_pdf_url TEXT;
