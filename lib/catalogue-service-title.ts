/**
 * TypeScript wrapper for `catalogue-service-title.js`.
 */

const impl = require('./catalogue-service-title.js') as {
  primaryServiceTitle: (stored: string | null | undefined) => string;
  applyCatalogueTitleToServiceName: (
    stored: string | null | undefined,
    catalogueTitle: string | null | undefined,
  ) => string | null;
};

export const primaryServiceTitle = impl.primaryServiceTitle;
export const applyCatalogueTitleToServiceName =
  impl.applyCatalogueTitleToServiceName;
