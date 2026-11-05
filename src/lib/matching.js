// Matching items mentioned in emails to items we already know about.
// Retailer emails often shorten or slightly reword product names, so we use
// several strategies, from most to least reliable. If two items match equally
// well we report "ambiguous" instead of guessing.

const STOP = new Set(['the', 'a', 'an', 'and', 'for', 'with', 'of', 'in', 'to', 'by', 'pack']);

export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[…]|\.\.\./g, ' ') // ellipsis from truncated names
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(s) {
  return new Set(normalizeName(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t)));
}

export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * candidates: [{ id, name, retailer_item_id }]
 * wanted: { name, retailerItemId }
 * Returns { match, method } | { ambiguous: [...] } | { match: null }
 */
export function matchItem(candidates, wanted) {
  if (wanted.retailerItemId) {
    const hits = candidates.filter((c) => c.retailer_item_id && c.retailer_item_id === wanted.retailerItemId);
    if (hits.length) return pickGroup(hits, 'retailer item id');
  }
  const n = normalizeName(wanted.name);
  if (!n) return { match: null };

  const exact = candidates.filter((c) => normalizeName(c.name) === n);
  if (exact.length) return pickGroup(exact, 'exact name');

  // Truncated names: "Anker 65W USB C Charger Nano" vs the full long title.
  if (n.length >= 12) {
    const prefix = candidates.filter((c) => {
      const cn = normalizeName(c.name);
      return cn.startsWith(n) || n.startsWith(cn);
    });
    if (prefix.length) return pickGroup(prefix, 'name prefix');
  }

  const scored = candidates
    .map((c) => ({ c, s: similarity(c.name, wanted.name) }))
    .filter((x) => x.s >= 0.5)
    .sort((x, y) => y.s - x.s);
  if (!scored.length) return { match: null };
  const top = scored.filter((x) => x.s === scored[0].s).map((x) => x.c);
  return pickGroup(top, 'similar name');
}

// Several rows can share a name legitimately: when part of a quantity is
// returned we split the row in two. Those are "the same product", so we
// return all of them and let the caller pick by stage.
function pickGroup(hits, method) {
  const names = new Set(hits.map((h) => normalizeName(h.name)));
  if (names.size > 1) return { ambiguous: hits, method };
  return { match: hits[0], group: hits, method };
}
