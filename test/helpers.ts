import type { Env } from "../src/env";

/** A minimal in-memory stand-in for a KV namespace, enough for these tests. */
export function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

/** An Env with only the bindings a given test actually touches. */
export function fakeEnv(kv = fakeKv()): Env {
  return {
    CONFIG: kv as unknown as KVNamespace,
    DB: undefined as unknown as D1Database,
    ADMIN_PASSWORD: "admin",
    SESSION_SECRET: "secret",
  };
}

/** Freshly valid Revizto tokens, so `getAccessToken` never tries to refresh. */
export function freshTokens(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    region: "sydney",
    accessToken: "test-access-token",
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: "test-refresh-token",
    connectedEmail: "sync@example.com",
    connectedName: "Sync Bot",
    connectedAt: new Date().toISOString(),
    ...overrides,
  });
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Replace global fetch with a stub that records every call and replies with the
 * queued JSON bodies, in order.
 */
export function stubFetch(responses: unknown[]): { calls: CapturedRequest[]; restore: () => void } {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()),
      body: init.body,
    });
    const payload = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
