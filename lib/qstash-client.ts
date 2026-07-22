/**
 * Shared QStash client.
 *
 * Upstash QStash is region-scoped. The SDK default (`https://qstash.upstash.io`)
 * routes to eu-central-1; a US-region token then fails every publish with
 * "user (…) not found in this region". Pin via `QSTASH_URL` (console →
 * QStash → REST URL), e.g. `https://qstash-us-east-1.upstash.io`.
 */

import { Client as QStashClient } from '@upstash/qstash';

/** Prefer explicit env; fall back to US regional URL (studio account region). */
export const DEFAULT_QSTASH_URL = 'https://qstash-us-east-1.upstash.io';

export function getQStashBaseUrl(): string {
  const fromEnv = process.env.QSTASH_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return DEFAULT_QSTASH_URL;
}

export function getQStashToken(): string | null {
  const token = process.env.QSTASH_TOKEN?.trim();
  return token && token.length > 0 ? token : null;
}

export function createQStashClient(): QStashClient | null {
  const token = getQStashToken();
  if (!token) return null;
  return new QStashClient({
    token,
    baseUrl: getQStashBaseUrl(),
  });
}
