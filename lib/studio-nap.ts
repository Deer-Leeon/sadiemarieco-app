/**
 * Canonical studio NAP (name / address / phone) for public SEO,
 * emails, and structured data. Keep every public surface in lockstep.
 */
export const STUDIO_BRAND_NAME = 'Sadie Marie';
export const STUDIO_LEGAL_NAME = 'Sadie Marie';
export const STUDIO_SITE_URL = 'https://www.sadiemarie.co';

/** Street address clients should navigate to (suite number). */
export const STUDIO_ADDRESS_LINE1 = '61 W 3200 N, Suite #10';
export const STUDIO_ADDRESS_LINE2 = 'Lehi, UT 84043';
export const STUDIO_ADDRESS_ONE_LINE =
  '61 W 3200 N, Suite #10, Lehi, UT 84043';

export const STUDIO_CITY = 'Lehi';
export const STUDIO_REGION = 'UT';
export const STUDIO_POSTAL = '84043';
export const STUDIO_COUNTRY = 'US';

/** Approximate geo for LocalBusiness schema (Serenity Studios Lehi). */
export const STUDIO_GEO = {
  latitude: 40.4249,
  longitude: -111.8794,
} as const;

export const STUDIO_PHONE_DISPLAY = '(385) 200-3904';
export const STUDIO_PHONE_E164 = '+13852003904';
export const STUDIO_PHONE_TEL = '3852003904';

export const STUDIO_EMAIL = 'mckenna@sadiemarie.co';
export const STUDIO_INSTAGRAM_URL = 'https://www.instagram.com/sadiemarie.co';

/**
 * Google Maps search URL for the studio. Prefer the Place URL from
 * Google Business Profile when available; this query form is stable.
 */
export const STUDIO_GOOGLE_MAPS_URL =
  'https://www.google.com/maps/search/?api=1&query=Sadie+Marie+61+W+3200+N+Suite+10+Lehi+UT';

export const STUDIO_HOST_VENUE = 'Serenity Studios';

export const STUDIO_AREA_SERVED = [
  'Lehi, UT',
  'American Fork, UT',
  'Saratoga Springs, UT',
  'Eagle Mountain, UT',
  'Highland, UT',
  'Pleasant Grove, UT',
  'Cedar Hills, UT',
  'Alpine, UT',
] as const;

export const STUDIO_LOGO_URL = `${STUDIO_SITE_URL}/assets/brand/logo-512.png`;
export const STUDIO_OG_IMAGE_URL = `${STUDIO_SITE_URL}/assets/brand/og-default.jpg`;
