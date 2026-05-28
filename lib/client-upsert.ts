/**
 * TypeScript wrapper for phone-first client upsert (implementation in client-upsert.js).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const impl = require('./client-upsert.js') as {
  upsertClientByPhonePrimary: (args: {
    firstName: string;
    lastName: string;
    email: string | null;
    phoneRaw: string;
  }) => Promise<{ clientId: string; normPhone: string }>;
  upsertClientByEmailFallback: (args: {
    firstName: string;
    lastName: string;
    email: string;
    normPhone: string | null;
  }) => Promise<string | null>;
};

export const upsertClientByPhonePrimary = impl.upsertClientByPhonePrimary;
export const upsertClientByEmailFallback = impl.upsertClientByEmailFallback;
