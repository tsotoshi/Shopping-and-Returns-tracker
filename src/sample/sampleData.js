// SAMPLE DATA — made-up orders for trying the app before Gmail is connected.
// Everything here is flagged is_sample = 1 and shown with a "Sample" badge.
// The policies below are INVENTED for demonstration and are not real
// retailer policies. Dates are relative to today so the dashboard is lively.
//
// The sample emails go through the exact same import pipeline real emails
// will, so trying the sample data also exercises the real logic.

import { addDays, todayISO } from '../lib/dates.js';
import { ingestParsedEmail } from '../services/ingest.js';
import { applyPolicyResult, manualStage, markDroppedOff } from '../services/items.js';

const SAMPLE_NOTE = 'SAMPLE policy for demonstration only — invented, not checked against any real retailer page.';

const samplePolicy = (overrides = {}) => ({
  policy: {
    eligible: true, windowDays: 30, startsFrom: 'delivery', dropoffDays: 14, confidence: 'estimated',
    refundTiming: { minDays: 3, maxDays: 5, unit: 'business', startEvent: 'refund_issued' },
    ...overrides,
  },
  explanation: SAMPLE_NOTE,
  sourceUrl: null,
  checkedAt: null,
});

export function loadSampleData(db, today = todayISO()) {
  const d = (n) => addDays(today, n);
  let seq = 0;
  const email = (o) => ingestParsedEmail(db, {
    messageId: `sample-${++seq}`, retailer: 'amazon', from: 'sample@example.invalid', webLink: null,
    receivedAt: o.eventDate ?? o.orderDate, ...o,
  }, { isSample: true });

  // 1. Headphones — delivered recently, still deciding
  email({ kind: 'order_confirmation', orderNumber: 'SAMPLE-111-0001', orderDate: d(-9), paymentMethod: 'Visa ••1234', subject: '[Sample] Your order of Wireless Headphones',
    items: [{ name: 'Wireless Noise-Cancelling Headphones', quantity: 1, unitPriceCents: 12999 }] });
  email({ kind: 'delivered', orderNumber: 'SAMPLE-111-0001', eventDate: d(-6), subject: '[Sample] Delivered: Wireless Headphones' });

  // 2. Two-item order: shoes to return (deadline soon), socks keeping
  email({ kind: 'order_confirmation', orderNumber: 'SAMPLE-111-0002', orderDate: d(-30), paymentMethod: 'Mastercard ••5678', subject: '[Sample] Your order of 2 items',
    items: [{ name: 'Trail Running Shoes, Size 10', quantity: 1, unitPriceCents: 8950 }, { name: 'Merino Wool Socks 3-Pack', quantity: 1, unitPriceCents: 2400 }] });
  email({ kind: 'delivered', orderNumber: 'SAMPLE-111-0002', eventDate: d(-27), subject: '[Sample] Delivered: 2 items' });

  // 3. Phone cases ×3 — returning 1 of 3 (partial return), label + QR ready
  email({ kind: 'order_confirmation', orderNumber: 'SAMPLE-111-0003', orderDate: d(-15), paymentMethod: 'Visa ••1234', subject: '[Sample] Your order of Phone Case',
    items: [{ name: 'Clear Phone Case with MagSafe', quantity: 3, unitPriceCents: 1599 }] });
  email({ kind: 'delivered', orderNumber: 'SAMPLE-111-0003', eventDate: d(-12), subject: '[Sample] Delivered: Phone Case' });
  email({ kind: 'return_started', orderNumber: 'SAMPLE-111-0003', eventDate: d(-1), subject: '[Sample] Your return of Phone Case',
    items: [{ name: 'Clear Phone Case with MagSafe', quantity: 1, refundCents: 1599 }],
    dropoffBy: d(6), qrUrl: 'https://example.invalid/sample-qr', instructions: 'Bring the item and QR code to a drop-off location. No box needed. (Sample instructions)' });

  // 4. Desk lamp (third-party seller) — dropped off, in transit
  email({ kind: 'order_confirmation', orderNumber: 'SAMPLE-111-0004', orderDate: d(-20), paymentMethod: 'Amex ••0005', subject: '[Sample] Your order of Desk Lamp',
    items: [{ name: 'LED Desk Lamp with USB Port', quantity: 1, unitPriceCents: 3499, seller: 'BrightHome Co. (sample seller)' }] });
  email({ kind: 'delivered', orderNumber: 'SAMPLE-111-0004', eventDate: d(-17), subject: '[Sample] Delivered: Desk Lamp' });
  email({ kind: 'return_started', orderNumber: 'SAMPLE-111-0004', eventDate: d(-5), subject: '[Sample] Return started', labelUrl: 'https://example.invalid/sample-label.pdf', instructions: 'Print the label and tape it to the box. (Sample instructions)' });
  email({ kind: 'dropped_off', orderNumber: 'SAMPLE-111-0004', eventDate: d(-3), subject: '[Sample] Drop-off receipt' });

  // 5. Rain jacket — refund issued 2 days ago, awaiting posting
  email({ kind: 'order_confirmation', orderNumber: 'SAMPLE-111-0005', orderDate: d(-25), paymentMethod: 'Visa ••1234', subject: '[Sample] Your order of Rain Jacket',
    items: [{ name: 'Packable Rain Jacket', quantity: 1, unitPriceCents: 5900 }] });
  email({ kind: 'delivered', orderNumber: 'SAMPLE-111-0005', eventDate: d(-22), subject: '[Sample] Delivered' });
  email({ kind: 'return_started', orderNumber: 'SAMPLE-111-0005', eventDate: d(-12), subject: '[Sample] Return started' });
  email({ kind: 'dropped_off', orderNumber: 'SAMPLE-111-0005', eventDate: d(-10), subject: '[Sample] Drop-off receipt' });
  email({ kind: 'return_received', orderNumber: 'SAMPLE-111-0005', eventDate: d(-4), subject: '[Sample] We received your return' });
  email({ kind: 'refund_issued', orderNumber: 'SAMPLE-111-0005', eventDate: d(-2), refundCents: 5900, refundDestination: 'Visa ••1234', subject: '[Sample] Your refund has been issued' });

  // 6. Blender — refund issued 12 days ago: time to check your account
  email({ kind: 'order_confirmation', orderNumber: 'SAMPLE-111-0006', orderDate: d(-40), paymentMethod: 'Mastercard ••5678', subject: '[Sample] Your order of Blender',
    items: [{ name: 'Compact Personal Blender', quantity: 1, unitPriceCents: 4499 }] });
  email({ kind: 'delivered', orderNumber: 'SAMPLE-111-0006', eventDate: d(-37), subject: '[Sample] Delivered' });
  email({ kind: 'return_started', orderNumber: 'SAMPLE-111-0006', eventDate: d(-25), subject: '[Sample] Return started' });
  email({ kind: 'refund_issued', orderNumber: 'SAMPLE-111-0006', eventDate: d(-12), refundCents: 4499, refundDestination: 'Mastercard ••5678', subject: '[Sample] Your refund has been issued' });

  // 7. Coffee grinder — partial refund ($60 of $80) issued
  email({ kind: 'order_confirmation', orderNumber: 'SAMPLE-111-0007', orderDate: d(-35), paymentMethod: 'Visa ••1234', subject: '[Sample] Your order of Coffee Grinder',
    items: [{ name: 'Burr Coffee Grinder', quantity: 1, unitPriceCents: 8000 }] });
  email({ kind: 'delivered', orderNumber: 'SAMPLE-111-0007', eventDate: d(-32), subject: '[Sample] Delivered' });
  email({ kind: 'return_started', orderNumber: 'SAMPLE-111-0007', eventDate: d(-20), subject: '[Sample] Return started' });
  email({ kind: 'dropped_off', orderNumber: 'SAMPLE-111-0007', eventDate: d(-18), subject: '[Sample] Drop-off receipt' });
  email({ kind: 'refund_issued', orderNumber: 'SAMPLE-111-0007', eventDate: d(-9), refundCents: 6000, refundDestination: 'Visa ••1234', subject: '[Sample] Partial refund issued' });

  // 8. Gift card — not returnable
  email({ kind: 'order_confirmation', orderNumber: 'SAMPLE-111-0008', orderDate: d(-3), paymentMethod: 'Visa ••1234', subject: '[Sample] Your gift card order',
    items: [{ name: 'Digital Gift Card $25', quantity: 1, unitPriceCents: 2500 }] });

  // 9. Kettle — ordered, not delivered yet (deadline is an estimate)
  email({ kind: 'order_confirmation', orderNumber: 'SAMPLE-111-0009', orderDate: d(-1), paymentMethod: 'Amex ••0005', subject: '[Sample] Your order of Electric Kettle',
    items: [{ name: 'Electric Kettle 1.7L', quantity: 1, unitPriceCents: 3999 }] });
  email({ kind: 'shipped', orderNumber: 'SAMPLE-111-0009', eventDate: d(0), estimatedDeliveryDate: d(2), subject: '[Sample] Shipped: Electric Kettle' });

  // 10. Speaker — delivered, policy unknown (needs review)
  email({ kind: 'order_confirmation', orderNumber: 'SAMPLE-111-0010', orderDate: d(-8), paymentMethod: 'Visa ••1234', subject: '[Sample] Your order of Bluetooth Speaker',
    items: [{ name: 'Portable Bluetooth Speaker', quantity: 1, unitPriceCents: 4999, seller: 'SoundDeals (sample seller)' }] });
  email({ kind: 'delivered', orderNumber: 'SAMPLE-111-0010', eventDate: d(-5), subject: '[Sample] Delivered' });

  // 11. An email the app can't match confidently — goes to "needs review"
  email({ kind: 'return_started', orderNumber: 'SAMPLE-111-0002', eventDate: d(-1), subject: '[Sample] Return started for an item (no item name in email)' });

  // Apply invented sample policies
  const rows = db.prepare('SELECT id, name FROM items WHERE is_sample = 1').all();
  const itemsByName = Object.fromEntries(rows.map((r) => [r.name, r.id]));
  for (const { id, name } of rows) {
    let result;
    if (name.startsWith('Digital Gift Card')) result = samplePolicy({ eligible: false, windowDays: null, confidence: 'confirmed' });
    else if (name.startsWith('Portable Bluetooth')) result = { policy: { eligible: null, windowDays: null, confidence: 'needs_review' }, explanation: `${SAMPLE_NOTE} Third-party seller policy unclear — needs review.`, sourceUrl: null, checkedAt: null };
    else if (name.startsWith('Packable Rain')) result = samplePolicy({ confidence: 'confirmed' });
    else if (name.startsWith('Compact Personal')) result = samplePolicy({ refundTiming: null });
    else result = samplePolicy();
    applyPolicyResult(db, id, result, 'sample');
  }

  // Manual decisions the "user" made in the sample
  manualStage(db, itemsByName['Trail Running Shoes, Size 10'], 'need_to_return', 'Too small (sample)', today);
  manualStage(db, itemsByName['Merino Wool Socks 3-Pack'], 'keeping', null, today);
  // Blender: no drop-off receipt in this story for the date, user typed it
  markDroppedOff(db, itemsByName['Compact Personal Blender'], d(-22), today);
}

export function clearSampleData(db) {
  db.transaction(() => {
    db.prepare('DELETE FROM emails WHERE is_sample = 1').run();
    db.prepare('DELETE FROM orders WHERE is_sample = 1').run();
  })();
}
