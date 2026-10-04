/** Which public landing a bookable service belongs on. */
export type ServiceFamily = 'lash' | 'brow' | 'other';

export function serviceFamily(category: string): ServiceFamily {
  const value = category.toLowerCase();
  if (value.includes('lash')) return 'lash';
  if (value.includes('brow')) return 'brow';
  return 'other';
}
