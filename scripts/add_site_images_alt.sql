-- Photo alt text, chosen file name, and which service (or portrait)
-- the picture shows. All nullable so existing rows keep the homepage's
-- hardcoded alt until an editor saves a replacement.
ALTER TABLE site_images ADD COLUMN IF NOT EXISTS alt_text TEXT;
ALTER TABLE site_images ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE site_images ADD COLUMN IF NOT EXISTS photo_subject TEXT;
