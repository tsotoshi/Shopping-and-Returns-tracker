// Stores the Gmail connection in the local database (never in the browser,
// never in git). Hands out a valid access token, refreshing when needed.

import { refreshAccessToken, revokeToken, OAuthError } from './oauth.js';

export const getAccount = (db) => db.prepare('SELECT * FROM gmail_account WHERE id = 1').get() ?? null;

export function saveAccount(db, { email, tokens, now = Date.now() }) {
  db.prepare(`INSERT INTO gmail_account (id, email, refresh_token, access_token, access_expires_at, scope, needs_reconnect, connected_at)
              VALUES (1, @email, @refresh, @access, @exp, @scope, 0, datetime('now'))
              ON CONFLICT (id) DO UPDATE SET email = @email, refresh_token = @refresh, access_token = @access,
                access_expires_at = @exp, scope = @scope, needs_reconnect = 0, connected_at = datetime('now')`)
    .run({ email, refresh: tokens.refresh_token, access: tokens.access_token, exp: now + (tokens.expires_in ?? 3600) * 1000, scope: tokens.scope });
}

export async function disconnect(db, fetchImpl = fetch) {
  const acct = getAccount(db);
  if (acct) await revokeToken(acct.refresh_token, fetchImpl); // tell Google to cancel access too
  db.prepare('DELETE FROM gmail_account').run();
}

/** Returns a function the Gmail client calls to get a current access token. */
export function tokenProvider(db, cfg, fetchImpl = fetch) {
  return async () => {
    const acct = getAccount(db);
    if (!acct) throw new OAuthError('Gmail is not connected.', { reconnect: true });
    if (acct.access_token && acct.access_expires_at > Date.now() + 60_000) return acct.access_token;
    try {
      const t = await refreshAccessToken(cfg, acct.refresh_token, fetchImpl);
      db.prepare('UPDATE gmail_account SET access_token = ?, access_expires_at = ?, needs_reconnect = 0 WHERE id = 1')
        .run(t.access_token, Date.now() + (t.expires_in ?? 3600) * 1000);
      return t.access_token;
    } catch (e) {
      if (e.reconnect) db.prepare('UPDATE gmail_account SET needs_reconnect = 1 WHERE id = 1').run();
      throw e;
    }
  };
}
