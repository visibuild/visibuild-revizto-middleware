/**
 * revizto/oauth.ts – the Revizto OAuth 2.0 authorization-code flow.
 *
 * Revizto has no machine-to-machine grant: every access token belongs to a
 * user. So an admin connects once from Settings and the Worker keeps the
 * resulting tokens. Access tokens last an hour; refresh tokens last a month
 * and **rotate** – each refresh revokes the token you sent, so losing a
 * rotation costs a re-authorisation. Everything below is built around not
 * losing one:
 *
 *  - tokens live under their own KV key, never inside the config blob;
 *  - refreshes take a short-lived KV lock and re-read before acting, so two
 *    concurrent invocations can't invalidate each other;
 *  - a failed refresh flips `needsReauth` rather than throwing away the state.
 */
import type { Env } from "../env";
import { regionHost, type ReviztoTokens } from "./types";

export const TOKENS_KEY = "revizto:tokens";
const LOCK_KEY = "revizto:refresh-lock";
const STATE_PREFIX = "revizto:oauth-state:";

/** Refresh this many seconds before the access token actually expires. */
const REFRESH_MARGIN = 120;
/** How long a refresh lock is held before it is assumed abandoned. */
const LOCK_TTL_SECONDS = 30;
/** An authorization code is valid for 10 minutes; the state need not outlive it. */
const STATE_TTL_SECONDS = 600;

export class ReviztoAuthError extends Error {
  /** True when the operator has to re-run the connect flow by hand. */
  needsReauth: boolean;
  constructor(message: string, needsReauth = false) {
    super(message);
    this.name = "ReviztoAuthError";
    this.needsReauth = needsReauth;
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// base64url + PKCE
// ---------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** S256 challenge for a verifier, as required for loopback and template URIs. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Step 1 – the authorization request
// ---------------------------------------------------------------------------

export interface PendingAuth {
  state: string;
  verifier: string;
  region: string;
  redirectUri: string;
}

/**
 * Mint (and remember) the one-time state and PKCE verifier for a connect
 * attempt, then build the URL to send the operator's browser to.
 *
 * PKCE is only mandatory for loopback and template redirect URIs, but we always
 * send it: it costs nothing and binds the code to this attempt.
 */
export async function beginAuth(
  env: Env,
  opts: { region: string; clientId: string; redirectUri: string },
): Promise<string> {
  const state = randomBase64Url(24);
  const verifier = randomBase64Url(32);
  const pending: PendingAuth = {
    state,
    verifier,
    region: opts.region,
    redirectUri: opts.redirectUri,
  };
  await env.CONFIG.put(`${STATE_PREFIX}${state}`, JSON.stringify(pending), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const sp = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
  });
  // `scope` is deliberately omitted – Revizto assigns scopes at registration.
  return `${regionHost(opts.region)}/v5/oauth2/authorize?${sp.toString()}`;
}

/** Consume the stored state for a callback. Returns null if unknown or expired. */
export async function takePendingAuth(env: Env, state: string): Promise<PendingAuth | null> {
  if (!state) return null;
  const key = `${STATE_PREFIX}${state}`;
  const raw = await env.CONFIG.get(key);
  if (!raw) return null;
  await env.CONFIG.delete(key); // single use
  try {
    return JSON.parse(raw) as PendingAuth;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2 / 4 – the token endpoint
// ---------------------------------------------------------------------------

interface TokenResponse {
  token_type?: string;
  expires_in?: number;
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
  hint?: string;
  message?: string;
}

/**
 * The token endpoint speaks plain OAuth 2.0 – unlike the rest of the Revizto
 * API, success is HTTP 200 and failure is a 4xx with an OAuth error body.
 */
async function postToken(region: string, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(`${regionHost(region)}/v5/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  let data: TokenResponse;
  try {
    data = (await res.json()) as TokenResponse;
  } catch {
    throw new ReviztoAuthError(`Revizto token endpoint returned HTTP ${res.status} with no JSON body.`);
  }
  if (!res.ok || !data.access_token) {
    const detail = [data.error, data.error_description ?? data.message, data.hint]
      .filter(Boolean)
      .join(" – ");
    // invalid_grant means the code or refresh token is spent, expired, or was
    // issued to another client; only a fresh authorisation fixes that.
    const needsReauth = data.error === "invalid_grant" || data.error === "invalid_client";
    throw new ReviztoAuthError(detail || `Revizto token request failed (HTTP ${res.status}).`, needsReauth);
  }
  return data;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Exchange an authorization code for the first token pair. */
export async function exchangeCode(
  region: string,
  creds: ClientCredentials,
  args: { code: string; redirectUri: string; verifier: string },
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const data = await postToken(
    region,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      // Must be byte-identical to the one sent at the authorize step.
      redirect_uri: args.redirectUri,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code_verifier: args.verifier,
    }),
  );
  return {
    accessToken: data.access_token!,
    refreshToken: data.refresh_token ?? "",
    expiresIn: data.expires_in ?? 3600,
  };
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export async function loadTokens(env: Env): Promise<ReviztoTokens | null> {
  const raw = await env.CONFIG.get(TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReviztoTokens;
  } catch {
    return null;
  }
}

export async function saveTokens(env: Env, tokens: ReviztoTokens): Promise<void> {
  await env.CONFIG.put(TOKENS_KEY, JSON.stringify(tokens));
}

export async function clearTokens(env: Env): Promise<void> {
  await env.CONFIG.delete(TOKENS_KEY);
}

/** Record that the stored refresh token no longer works, without losing context. */
async function markNeedsReauth(env: Env, tokens: ReviztoTokens, message: string): Promise<void> {
  await saveTokens(env, { ...tokens, needsReauth: true, lastError: message, accessToken: "", accessTokenExpiresAt: 0 });
}

// ---------------------------------------------------------------------------
// Single-flight refresh
// ---------------------------------------------------------------------------

/**
 * Try to take the refresh lock. KV has no compare-and-set, so this writes a
 * random owner value and reads it back: if what comes back is ours, we hold the
 * lock. That is not airtight under a true race, but the hourly cron is the only
 * scheduled refresher, so contention is rare – and the loser waits and re-reads
 * rather than refreshing, which is the outcome that actually matters.
 */
async function acquireLock(env: Env): Promise<string | null> {
  const existing = await env.CONFIG.get(LOCK_KEY);
  if (existing) return null;
  const owner = randomBase64Url(12);
  await env.CONFIG.put(LOCK_KEY, owner, { expirationTtl: LOCK_TTL_SECONDS });
  const readBack = await env.CONFIG.get(LOCK_KEY);
  return readBack === owner ? owner : null;
}

async function releaseLock(env: Env, owner: string): Promise<void> {
  const current = await env.CONFIG.get(LOCK_KEY);
  if (current === owner) await env.CONFIG.delete(LOCK_KEY);
}

function isFresh(tokens: ReviztoTokens): boolean {
  return Boolean(tokens.accessToken) && tokens.accessTokenExpiresAt - REFRESH_MARGIN > now();
}

async function refreshOnce(
  env: Env,
  creds: ClientCredentials,
  tokens: ReviztoTokens,
): Promise<ReviztoTokens> {
  const data = await postToken(
    tokens.region,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  );
  const next: ReviztoTokens = {
    ...tokens,
    accessToken: data.access_token!,
    // Compute expiry from our own clock at receipt, not from the token itself.
    accessTokenExpiresAt: now() + (data.expires_in ?? 3600),
    // Refresh tokens rotate: persisting the new one is not optional.
    refreshToken: data.refresh_token || tokens.refreshToken,
    needsReauth: false,
    lastError: undefined,
  };
  await saveTokens(env, next);
  return next;
}

/**
 * Return a usable access token, refreshing if needed.
 *
 * Throws a `ReviztoAuthError` with `needsReauth` set when the operator has to
 * reconnect – callers should surface that rather than retrying, since hammering
 * the token endpoint after a failure achieves nothing.
 */
export async function getAccessToken(env: Env, creds: ClientCredentials): Promise<string> {
  let tokens = await loadTokens(env);
  if (!tokens) throw new ReviztoAuthError("Revizto is not connected.", true);
  if (tokens.needsReauth) {
    throw new ReviztoAuthError(tokens.lastError || "Revizto needs to be reconnected.", true);
  }
  if (isFresh(tokens)) return tokens.accessToken;
  if (!tokens.refreshToken) throw new ReviztoAuthError("No Revizto refresh token stored.", true);

  const owner = await acquireLock(env);
  if (!owner) {
    // Someone else is refreshing. Re-read once – KV is eventually consistent,
    // so this may still be the old value, in which case we use the stale token
    // and let the next call pick up the rotation.
    const latest = await loadTokens(env);
    if (latest && isFresh(latest)) return latest.accessToken;
    if (tokens.accessToken) return tokens.accessToken;
    throw new ReviztoAuthError("A Revizto token refresh is already in progress. Try again shortly.");
  }

  try {
    // Re-read under the lock: another invocation may have just rotated.
    const latest = await loadTokens(env);
    if (latest) tokens = latest;
    if (isFresh(tokens)) return tokens.accessToken;
    const next = await refreshOnce(env, creds, tokens);
    return next.accessToken;
  } catch (e) {
    const err = e instanceof ReviztoAuthError ? e : new ReviztoAuthError((e as Error).message);
    if (err.needsReauth) await markNeedsReauth(env, tokens, err.message);
    throw err;
  } finally {
    await releaseLock(env, owner);
  }
}

/** The redirect URI to register in the Revizto developer portal, for this deployment. */
export function redirectUriFor(requestUrl: string): string {
  const u = new URL(requestUrl);
  return `${u.origin}/settings/revizto/callback`;
}
