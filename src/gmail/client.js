// Minimal Gmail API client (read-only calls only) + helpers to turn Gmail's
// message format into plain text we can parse.

import { todayISO } from '../lib/dates.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailError extends Error {
  constructor(status, body) {
    super(`Gmail API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

export function createGmailClient({ getAccessToken, fetchImpl = fetch }) {
  async function call(path) {
    const token = await getAccessToken();
    const res = await fetchImpl(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new GmailError(res.status, await res.text().catch(() => ''));
    return res.json();
  }
  return {
    profile: () => call('/profile'),
    /** Message IDs matching a Gmail search, newest first. */
    async listMessageIds(q, max = 500) {
      const ids = [];
      let pageToken;
      do {
        const p = new URLSearchParams({ q, maxResults: String(Math.min(100, max - ids.length)) });
        if (pageToken) p.set('pageToken', pageToken);
        const page = await call(`/messages?${p}`);
        for (const m of page.messages ?? []) ids.push(m.id);
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);
      return ids;
    },
    getMessage: (id) => call(`/messages/${encodeURIComponent(id)}?format=full`),
  };
}

// ---------- decoding ----------

function b64url(data) {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function walk(part, out) {
  if (!part) return;
  if (part.body?.data && part.mimeType === 'text/plain') out.text.push(b64url(part.body.data));
  if (part.body?.data && part.mimeType === 'text/html') out.html.push(b64url(part.body.data));
  for (const p of part.parts ?? []) walk(p, out);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|td|th)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
}

export function extractLinks(html) {
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) links.push({ href: decodeEntities(m[1]), text: htmlToText(m[2]).replace(/\s+/g, ' ').trim() });
  return links;
}

/**
 * Many stores embed a machine-readable order summary (schema.org JSON-LD,
 * the same data Gmail uses for its order "highlights"). Pull those out.
 */
export function extractStructuredData(html) {
  const out = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const queue = Array.isArray(data) ? [...data] : [data];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
        if (node['@type']) out.push(node);
      }
    } catch {
      // Malformed markup: ignore it, the text parser still runs.
    }
  }
  return out;
}

/** Gmail API message -> { id, threadId, subject, from, receivedAt, date, text, links, structured } */
export function decodeMessage(msg) {
  const headers = Object.fromEntries((msg.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  const out = { text: [], html: [] };
  walk(msg.payload, out);
  const html = out.html.join('\n');
  // Prefer the HTML version (it has links); fall back to plain text.
  const raw = html ? htmlToText(html) : out.text.join('\n');
  const text = raw.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
  const ms = Number(msg.internalDate) || Date.parse(headers.date) || Date.now();
  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: headers.subject ?? '',
    from: headers.from ?? '',
    receivedAt: new Date(ms).toISOString(),
    date: todayISO(new Date(ms)), // local calendar date the email arrived
    text,
    links: html ? extractLinks(html) : [],
    structured: html ? extractStructuredData(html) : [],
  };
}

export function gmailWebLink(messageId, accountEmail) {
  const u = accountEmail ? `?authuser=${encodeURIComponent(accountEmail)}` : '';
  return `https://mail.google.com/mail/${u}#all/${messageId}`;
}
