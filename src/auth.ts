/**
 * auth.ts – stateless session tokens signed with HMAC-SHA256 (Web Crypto).
 *
 * A token is `<payload>.<signature>` where payload is base64url-encoded JSON
 * ({ role, exp }) and signature is base64url(HMAC-SHA256(payload)). Tokens live
 * in an httpOnly cookie; verification recomputes the HMAC and checks expiry, so
 * there is no server-side session store (and therefore no users table).
 */

export type Role = "admin" | "viewer";

export interface Session {
  role: Role;
  exp: number; // epoch seconds
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SESSION_COOKIE = "vb_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(secret: string, data: string): Promise<Uint8Array> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

/** Constant-time byte comparison. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Constant-time string comparison, for password checks. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

export async function createSessionToken(
  secret: string,
  role: Role,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ role, exp })));
  const sig = bytesToBase64Url(await sign(secret, payload));
  return `${payload}.${sig}`;
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined | null,
): Promise<Session | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const providedSigStr = token.slice(dot + 1);

  let expectedSig: Uint8Array;
  let providedSig: Uint8Array;
  try {
    expectedSig = await sign(secret, payload);
    providedSig = base64UrlToBytes(providedSigStr);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expectedSig, providedSig)) return null;

  let session: Session;
  try {
    session = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
  } catch {
    return null;
  }
  if (session.role !== "admin" && session.role !== "viewer") return null;
  if (typeof session.exp !== "number" || session.exp < Math.floor(Date.now() / 1000)) return null;
  return session;
}
