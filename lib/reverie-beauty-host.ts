/** Maggie / Reverie Beauty client-handoff subdomain. */

export const REVERIE_BEAUTY_HOST = 'reveriebeauty.sadiemarie.co';

export function isReverieBeautyHost(hostHeader: string | null): boolean {
  const host = (hostHeader || '').split(':')[0].toLowerCase();
  return host === REVERIE_BEAUTY_HOST;
}
