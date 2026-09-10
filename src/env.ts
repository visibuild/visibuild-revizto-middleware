/**
 * env.ts – Worker bindings.
 *
 * KV holds the editable configuration, the Revizto OAuth tokens and the
 * hard-cached Visibuild lookups. D1 holds the sync state (project pairs, visi
 * -> issue links, run log). The two secrets are set with `wrangler secret put`
 * (or .dev.vars locally); every third-party credential is entered in Settings
 * instead, so a redeploy never needs them.
 */
export interface Env {
  CONFIG: KVNamespace;
  DB: D1Database;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  DEFAULT_VISIBUILD_API_URL?: string;
}
