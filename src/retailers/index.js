// Retailer registry. Each retailer says how to find its emails in Gmail and
// how to parse them into the shared "parsed email" shape that
// services/ingest.js understands. Adding a retailer = adding an entry here
// plus a parser file; the sync and import code don't change.

import { parseAmazonEmails, PARSER_VERSION, isFromAmazon } from './amazon.js';
import { parseGenericEmails, GENERIC_PARSER_VERSION, looksLikePurchase } from './generic.js';

const AMAZON_ALL = 'from:amazon.com subject:(ordered OR order OR shipped OR delivered OR return OR refund OR "drop off")';
const AMAZON_RETURNS = 'from:amazon.com subject:(return OR refund OR "drop off" OR "dropped off")';

// Purchase phrases searched across ALL mail (not just Gmail's Purchases category).
// Gmail searches the whole email text, then the app checks each match's subject
// and preview before downloading it.
const OTHER_STORES = '-from:amazon.com ("order number" OR "order #" OR "order no" OR "order confirmation" OR "order confirmed" OR "is confirmed" '
  + 'OR "your order" OR "thank you for your order" OR "thanks for your order" OR "thank you for your purchase" OR receipt '
  + 'OR "has shipped" OR "on its way" OR "was delivered" OR "your package" OR refund OR "return label" OR "your return")';

export const RETAILERS = {
  amazon: {
    id: 'amazon',
    name: 'Amazon',
    // With Amazon order details on, purchases come from your Amazon order pages
    // and Amazon emails are only used for returns and refunds.
    gmailQuery: ({ amazonFromSite }) => (amazonFromSite ? AMAZON_RETURNS : AMAZON_ALL),
    skipKinds: ({ amazonFromSite }) => (amazonFromSite ? ['order_confirmation', 'shipped', 'delivered'] : []),
    modeTag: ({ amazonFromSite }) => (amazonFromSite ? 'site' : ''),
    parse: parseAmazonEmails, // returns one parsed email per order (an email can hold several)
    parserVersion: PARSER_VERSION,
    isFrom: isFromAmazon,
  },
  other: {
    id: 'other',
    name: 'Other stores',
    gmailQuery: OTHER_STORES,
    triage: looksLikePurchase,
    maxMessages: 2000,
    parse: parseGenericEmails,
    parserVersion: GENERIC_PARSER_VERSION,
  },
};

export const retailerName = (id) => RETAILERS[id]?.name ?? id;
