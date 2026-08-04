/**
 * JSON-LD builders for BeautySalon + FAQPage structured data.
 */
import {
  STUDIO_ADDRESS_LINE1,
  STUDIO_AREA_SERVED,
  STUDIO_CITY,
  STUDIO_COUNTRY,
  STUDIO_EMAIL,
  STUDIO_GEO,
  STUDIO_GOOGLE_MAPS_URL,
  STUDIO_HOST_VENUE,
  STUDIO_INSTAGRAM_URL,
  STUDIO_LEGAL_NAME,
  STUDIO_LOGO_URL,
  STUDIO_OG_IMAGE_URL,
  STUDIO_PHONE_E164,
  STUDIO_POSTAL,
  STUDIO_REGION,
  STUDIO_SITE_URL,
} from '@/lib/studio-nap';

export type StudioHoursDay = {
  /** ISO weekday 1=Monday … 7=Sunday */
  dayOfWeek: number;
  opens: string;
  closes: string;
};

const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export function buildBeautySalonJsonLd(opts?: {
  hours?: StudioHoursDay[];
  placeId?: string | null;
}): Record<string, unknown> {
  const sameAs = [STUDIO_INSTAGRAM_URL, STUDIO_GOOGLE_MAPS_URL];
  const placeId = opts?.placeId?.trim();
  if (placeId) {
    sameAs.push(`https://www.google.com/maps/place/?q=place_id:${placeId}`);
  }

  const openingHoursSpecification = (opts?.hours ?? [])
    .filter((h) => h.dayOfWeek >= 1 && h.dayOfWeek <= 7)
    .map((h) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: DAY_NAMES[h.dayOfWeek - 1],
      opens: h.opens,
      closes: h.closes,
    }));

  return {
    '@context': 'https://schema.org',
    '@type': 'BeautySalon',
    '@id': `${STUDIO_SITE_URL}/#business`,
    name: STUDIO_LEGAL_NAME,
    description:
      'Luxury beauty studio in Lehi, Utah offering lash extensions, brow artistry, and signature beauty services.',
    url: STUDIO_SITE_URL,
    logo: STUDIO_LOGO_URL,
    image: [STUDIO_OG_IMAGE_URL, STUDIO_LOGO_URL],
    telephone: STUDIO_PHONE_E164,
    email: STUDIO_EMAIL,
    priceRange: '$$',
    address: {
      '@type': 'PostalAddress',
      streetAddress: STUDIO_ADDRESS_LINE1,
      addressLocality: STUDIO_CITY,
      addressRegion: STUDIO_REGION,
      postalCode: STUDIO_POSTAL,
      addressCountry: STUDIO_COUNTRY,
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: STUDIO_GEO.latitude,
      longitude: STUDIO_GEO.longitude,
    },
    hasMap: STUDIO_GOOGLE_MAPS_URL,
    sameAs,
    areaServed: STUDIO_AREA_SERVED.map((name) => ({
      '@type': 'City',
      name,
    })),
    containedInPlace: {
      '@type': 'Place',
      name: STUDIO_HOST_VENUE,
    },
    ...(openingHoursSpecification.length > 0
      ? { openingHoursSpecification }
      : {}),
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: 'Beauty services',
      itemListElement: [
        {
          '@type': 'OfferCatalog',
          name: 'Lash Services',
          itemListElement: [
            {
              '@type': 'Offer',
              itemOffered: {
                '@type': 'Service',
                name: 'Lash Extensions',
                areaServed: STUDIO_CITY,
              },
            },
          ],
        },
        {
          '@type': 'OfferCatalog',
          name: 'Brow Services',
          itemListElement: [
            {
              '@type': 'Offer',
              itemOffered: {
                '@type': 'Service',
                name: 'Brow Artistry',
                areaServed: STUDIO_CITY,
              },
            },
          ],
        },
      ],
    },
  };
}

export type FaqItem = { question: string; answer: string };

export function buildFaqPageJsonLd(faqs: FaqItem[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };
}

export function jsonLdScriptTag(data: Record<string, unknown>): string {
  // Prevent </script> breakout in JSON values.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

/** Homepage FAQs mirrored from public/index.html. */
export const HOMEPAGE_FAQS: FaqItem[] = [
  {
    question: 'How do I prepare for my lash appointment?',
    answer:
      'Please arrive with clean, makeup-free lashes and eyes. Remove contact lenses before your appointment. Avoid caffeine beforehand as it can cause eye twitching. Do not curl your lashes on the day of the appointment.',
  },
  {
    question: 'How long do lash extensions last?',
    answer:
      'Lash extensions naturally shed with your own lash cycle, typically every 6–8 weeks. To maintain full, beautiful lashes, I recommend a fill appointment every 2–3 weeks. With proper aftercare, your extensions can look stunning for much longer.',
  },
  {
    question: 'What if I have a reaction or am unhappy with my results?',
    answer:
      'Your satisfaction and safety are my top priorities. If you experience any discomfort or reaction, please contact me immediately. I offer a complimentary adjustment within 48 hours of your appointment if there are any concerns with your results.',
  },
  {
    question: 'Is parking available near the studio?',
    answer:
      "Yes! Complimentary parking is available in the building's parking lot, with spaces reserved for Serenity Studios clients. You'll find Sadie Marie conveniently located inside Serenity Studios in Lehi, Utah.",
  },
];
