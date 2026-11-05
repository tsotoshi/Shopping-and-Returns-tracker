// Retailer registry. Each retailer says how to find its emails in Gmail and
// how to parse them into the shared "parsed email" shape that
// services/ingest.js understands. Adding a retailer = adding an entry here
// plus a parser file; the sync and import code don't change.

import { parseAmazonEmail } from './amazon.js';

export const RETAILERS = {
  amazon: {
    id: 'amazon',
    name: 'Amazon',
    // Gmail search (read-only). Sender + subject words keep us from
    // downloading unrelated mail; the parser double-checks each message.
    gmailQuery: 'from:amazon.com subject:(ordered OR order OR shipped OR delivered OR return OR refund OR "drop off")',
    parse: parseAmazonEmail,
  },
};

export const retailerName = (id) => RETAILERS[id]?.name ?? id;
