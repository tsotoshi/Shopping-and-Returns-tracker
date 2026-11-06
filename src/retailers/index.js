// Retailer registry. Each retailer says how to find its emails in Gmail and
// how to parse them into the shared "parsed email" shape that
// services/ingest.js understands. Adding a retailer = adding an entry here
// plus a parser file; the sync and import code don't change.

import { parseAmazonEmails, PARSER_VERSION, isFromAmazon } from './amazon.js';
import { parseGenericEmails, GENERIC_PARSER_VERSION } from './generic.js';

export const RETAILERS = {
  amazon: {
    id: 'amazon',
    name: 'Amazon',
    // Gmail search (read-only). Sender + subject words keep us from
    // downloading unrelated mail; the parser double-checks each message.
    gmailQuery: 'from:amazon.com subject:(ordered OR order OR shipped OR delivered OR return OR refund OR "drop off")',
    parse: parseAmazonEmails, // returns one parsed email per order (an email can hold several)
    parserVersion: PARSER_VERSION,
    isFrom: isFromAmazon,
  },
  // Every other store. Gmail's own "Purchases" category does most of the
  // finding; promotions and social mail are excluded.
  other: {
    id: 'other',
    name: 'Other stores',
    gmailQuery: '(category:purchases OR subject:(order OR shipped OR delivered OR refund OR return OR receipt)) -from:amazon.com -category:promotions -category:social',
    parse: parseGenericEmails,
    parserVersion: GENERIC_PARSER_VERSION,
  },
};

export const retailerName = (id) => RETAILERS[id]?.name ?? id;
