// Retailer registry. Each retailer module describes how to find its emails
// and (from Stage 2) how to parse them into the shared "parsed email" shape
// that services/ingest.js understands. Adding a retailer = adding a file here.

export const RETAILERS = {
  amazon: {
    id: 'amazon',
    name: 'Amazon',
    // Gmail search used by Stage 2 sync (read-only).
    gmailQuery: 'from:(amazon.com) newer_than:180d',
    parse: null, // Stage 2: src/retailers/amazon.js
  },
};

export const retailerName = (id) => RETAILERS[id]?.name ?? id;
