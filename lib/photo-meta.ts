import { serviceFamily, type ServiceFamily } from '@/lib/seo-service-pages';

/** Choice stored when a photo is a portrait or the studio, not a service. */
export const PORTRAIT_SUBJECT = 'portrait';

export type PhotoServiceOption = {
  slug: string;
  title: string;
  category: string;
};

export type PhotoCopy = {
  alt: string;
  fileName: string;
};

const FILE_NAME_MAX = 80;

/**
 * Suggested alt text and file name for a website photo. The editor
 * can change both before saving. An empty subject returns empty
 * suggestions so an untouched photo keeps the homepage's existing alt.
 */
export function suggestPhotoCopy(
  subject: string,
  services: readonly PhotoServiceOption[]
): PhotoCopy {
  if (subject === PORTRAIT_SUBJECT) {
    return {
      alt: 'Sadie Marie, lash and brow studio in Lehi, Utah',
      fileName: 'sadie-marie-lehi-utah',
    };
  }

  const service = services.find((row) => row.slug === subject);
  if (!service) return { alt: '', fileName: '' };

  const family: ServiceFamily = serviceFamily(service.category);
  const fileName = fileNameFromTitle(service.title);
  if (family === 'lash') {
    return {
      alt: `${service.title} by Sadie Marie at Serenity Studios in Lehi, Utah`,
      fileName,
    };
  }
  if (family === 'brow') {
    return {
      alt: `${service.title} by Sadie Marie in Lehi, Utah`,
      fileName,
    };
  }
  return {
    alt: `${service.title} at Sadie Marie in Lehi, Utah`,
    fileName,
  };
}

export function fileNameFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = slug.length > 0 ? slug : 'sadie-marie';
  const withPlace = `${base}-lehi-utah`;
  return withPlace.slice(0, FILE_NAME_MAX).replace(/-+$/g, '');
}

/** Blob basename: letters, numbers, and hyphens only. */
export function sanitisePhotoFileName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, FILE_NAME_MAX)
    .replace(/-+$/g, '');
  return cleaned;
}
