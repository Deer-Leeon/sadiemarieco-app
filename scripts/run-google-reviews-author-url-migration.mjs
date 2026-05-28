import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from '@vercel/postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ddl = readFileSync(
  join(__dirname, 'add_google_reviews_author_url.sql'),
  'utf8'
);

await sql.query(ddl);
console.log('google_reviews.author_url migration applied.');
