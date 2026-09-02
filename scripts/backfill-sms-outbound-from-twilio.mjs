// Usage:
//   node --env-file=.env.local scripts/backfill-sms-outbound-from-twilio.mjs
//
// Pulls outbound studio SMS from Twilio into sms_outbound_log so client
// text history is complete back to Twilio's Message retention window
// (typically about 13 months). Safe to re-run; Twilio SIDs are unique.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { importAllTwilioOutbound } = require('../lib/sms-outbound-log.js');

console.log('Fetching outbound SMS from Twilio…');

const result = await importAllTwilioOutbound({ limit: 8000 });

if (result.skipped) {
  console.error(`Skipped: ${result.reason || 'unknown'}`);
  process.exit(1);
}

console.log(
  `Scanned ${result.scanned} Twilio messages, imported ${result.imported} new rows.`
);
process.exit(0);
