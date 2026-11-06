// Builds fake messages in the Gmail API's real format, and a fake Gmail
// client, so tests never touch a real inbox.
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function gmailMessage({ id, subject, html, text, from = 'Amazon.com <auto-confirm@amazon.com>', date = '2026-10-01T15:00:00' }) {
  const parts = [];
  if (text) parts.push({ mimeType: 'text/plain', body: { data: b64url(text) } });
  if (html) parts.push({ mimeType: 'text/html', body: { data: b64url(html) } });
  return {
    id, threadId: `t-${id}`, internalDate: String(new Date(date).getTime()),
    payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }], parts },
  };
}

export function fakeGmail(messages) {
  const calls = { list: [], get: [] };
  return {
    calls,
    add(m) { messages.push(m); },
    async listMessageIds(q) { calls.list.push(q); return [...messages].reverse().map((m) => m.id); }, // newest first, like Gmail
    async getMessage(id) { calls.get.push(id); return messages.find((m) => m.id === id); },
    async profile() { return { emailAddress: 'me@example.com' }; },
  };
}

export const orderHtml = `
<html><body><table>
<tr><td>Hello Sam, thanks for your order!</td></tr>
<tr><td>Order #113-1234567-7654321</td></tr>
<tr><td>Arriving: Thursday, October 8</td></tr>
<tr><td><a href="https://www.amazon.com/dp/B0TEST">Anker 735 Charger (Nano II 65W), 3-Port Fast Compact Foldable USB C Charger</a></td></tr>
<tr><td>Sold by: Anker Direct</td></tr>
<tr><td>Quantity: 1</td></tr>
<tr><td>$39.99</td></tr>
<tr><td>Merino Wool Socks 3-Pack</td></tr>
<tr><td>Quantity: 2</td></tr>
<tr><td>$12.00</td></tr>
<tr><td>Order Total: $63.99</td></tr>
<tr><td>Paid with Visa ending in 4242</td></tr>
</table></body></html>`;

// Modeled on a real 2026 Amazon confirmation: two orders in one email,
// categories instead of product names, and only a grand total per order.
export const twoOrderHtml = `
<html><body><table>
<tr><td><a href="https://www.amazon.com/gp/css/order-history">Your Orders</a></td><td>Your Account</td></tr>
<tr><td>Eric, thanks for your order!</td></tr>
<tr><td>Ordered</td><td>Shipped</td><td>Out for delivery</td><td>Delivered</td></tr>
<tr><td><b>Arriving overnight 3 AM – 6 AM</b></td></tr>
<tr><td>2 items: 1 Household Supplies, 1 Home Fragrance</td></tr>
<tr><td>Eric - Quincy, MA</td></tr>
<tr><td>Order # 111-3646931-0001058</td></tr>
<tr><td><a href="https://www.amazon.com/gp/your-account/order-details">View or edit order</a></td></tr>
<tr><td>Grand Total:</td><td>$25.46</td></tr>
<tr><td><b>Arriving today 5 PM – 8 PM</b></td></tr>
<tr><td>1 Storage &amp; Organization item</td></tr>
<tr><td>Eric - Quincy, MA</td></tr>
<tr><td>Order # 111-7056707-4221854</td></tr>
<tr><td><a href="https://www.amazon.com/gp/your-account/order-details">View or edit order</a></td></tr>
<tr><td>Grand Total:</td><td>$23.36</td></tr>
<tr><td>Need help? Visit Help &amp; Customer Service</td></tr>
</table></body></html>`;
