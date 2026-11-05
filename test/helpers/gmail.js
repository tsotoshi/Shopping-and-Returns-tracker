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
