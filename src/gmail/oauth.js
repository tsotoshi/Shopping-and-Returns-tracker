// Google OAuth ("Sign in with Google") for Gmail, done with plain HTTPS calls
// so every step is visible. Flow:
//   1. buildAuthUrl()   -> we send you to Google's own consent page
//   2. Google sends you back to /auth/google/callback?code=...
//   3. exchangeCode()   -> we trade that one-time code for tokens
//   4. refreshAccessToken() gets a fresh 1-hour access token when needed
// Your Google password never passes through this app.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

export class OAuthError extends Error {
  constructor(message, { reconnect = false } = {}) {
    super(message);
    this.reconnect = reconnect;
  }
}

export function googleConfig(env = process.env) {
  const cfg = {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: env.GOOGLE_REDIRECT_URI || '',
  };
  cfg.configured = !!(cfg.clientId && cfg.clientSecret && cfg.redirectUri);
  return cfg;
}

export function buildAuthUrl(cfg, state) {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: GMAIL_READONLY, // read-only: Google itself blocks any change to your mail
    access_type: 'offline', // gives a refresh token so you don't log in every hour
    prompt: 'consent',
    include_granted_scopes: 'false',
    state, // random value we check on return, to block forged callbacks
  });
  return `${AUTH_URL}?${p}`;
}

/**
 * Make sure Google granted read-only Gmail access and NOTHING broader.
 * If somehow a write scope was granted, we refuse to store the token.
 */
export function checkScopes(scopeString) {
  const scopes = String(scopeString || '').split(/\s+/).filter(Boolean);
  if (!scopes.includes(GMAIL_READONLY)) {
    throw new OAuthError('Google did not grant read-only Gmail access. Please try again and tick the Gmail permission.');
  }
  const extraGmail = scopes.filter((s) => s !== GMAIL_READONLY && (s.includes('mail.google.com') || s.includes('/auth/gmail')));
  if (extraGmail.length) {
    throw new OAuthError(`Refusing to connect: Google granted more than read-only access (${extraGmail.join(', ')}).`);
  }
  return scopes;
}

async function postForm(fetchImpl, url, params) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export async function exchangeCode(cfg, code, fetchImpl = fetch) {
  const r = await postForm(fetchImpl, TOKEN_URL, {
    code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code',
  });
  if (!r.ok) throw new OAuthError(`Google sign-in failed: ${r.body.error_description || r.body.error || r.status}`);
  if (!r.body.refresh_token) {
    throw new OAuthError('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  }
  checkScopes(r.body.scope);
  return r.body; // { access_token, refresh_token, expires_in, scope }
}

export async function refreshAccessToken(cfg, refreshToken, fetchImpl = fetch) {
  const r = await postForm(fetchImpl, TOKEN_URL, {
    refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token',
  });
  if (!r.ok) {
    // invalid_grant = token expired or revoked. In Google's "Testing" mode
    // this happens every 7 days; you just reconnect.
    const reconnect = r.body.error === 'invalid_grant';
    throw new OAuthError(reconnect ? 'Gmail access expired — please reconnect.' : `Could not refresh Gmail access (${r.body.error || r.status})`, { reconnect });
  }
  return r.body; // { access_token, expires_in, scope }
}

export async function revokeToken(token, fetchImpl = fetch) {
  try {
    await postForm(fetchImpl, REVOKE_URL, { token });
  } catch {
    // Best effort: we delete our copy either way.
  }
}
