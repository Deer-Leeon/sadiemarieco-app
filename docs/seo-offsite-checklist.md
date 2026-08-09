# Off-site SEO checklist (owner)

Website changes in this repo handle technical SEO, landing pages, and
structured data. Rankings for local “lashes / brows Lehi” and the Google
result logo also depend on work outside the codebase.

## Google Business Profile

1. Claim or open the listing for **Sadie Marie** in Lehi.
2. Match NAP exactly to the website:
   - Name: Sadie Marie
   - Address: 61 W 3200 N, Suite #10, Lehi, UT 84043
   - Phone: (385) 200-3904
   - Website: https://www.sadiemarie.co
3. Primary category: **Eyelash Salon** (or Beauty Salon) + add brows/skincare.
4. Upload the square logo (`public/assets/brand/logo-512.png` — the real cream script mark) and cover photos.
5. Add services with prices where possible; keep hours aligned with Cal.
6. Post regularly and reply to every review.
7. Copy the Place URL / Place ID into `NEXT_PUBLIC_GOOGLE_PLACE_ID` if not already set (used for reviews sync + schema `sameAs`).
8. **Booking link:** set the Google Business Profile / Maps **Book** appointment URL to `https://www.sadiemarie.co/book` (phone guided booker). Do not use `#services` — that dumps people onto the marketing list.

## Google Search Console

1. Verify `https://www.sadiemarie.co` (DNS or HTML tag).
2. Submit sitemap: `https://www.sadiemarie.co/sitemap.xml`
3. Request indexing for:
   - `/`
   - `/lash-extensions-lehi`
   - `/brow-services-lehi`
   - `/beauty-studio-lehi`
   - `/areas-we-serve`
4. After favicon deploy, re-inspect `/` so Google can pick up the new icon (can take days–weeks).

## Citations & brand consistency

- Instagram bio: same NAP + link to www.sadiemarie.co
- Apple Maps / Yelp / Facebook (if used): same name, address, phone
- Prefer “Sadie Marie at Serenity Studios” so the brand entity stays primary

## Reviews

- Keep asking happy clients for Google reviews
- Site carousel syncs via `/api/cron/sync-reviews` (QStash daily schedule — not Vercel Cron)

## Validate after deploy

- [Rich Results Test](https://search.google.com/test/rich-results) on the homepage
- Confirm favicon shows at `https://www.sadiemarie.co/favicon.ico` and `/assets/brand/favicon-32.png`
- Confirm `robots.txt` and `sitemap.xml` resolve
