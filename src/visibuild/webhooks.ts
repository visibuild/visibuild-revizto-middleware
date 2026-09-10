/**
 * visibuild/webhooks.ts – manage Visibuild webhook endpoints.
 *
 * Visibuild does not yet emit an event that would let us sync visis on a push
 * basis, so the sync engine polls `updatedAfter` instead. This module exists so
 * the plumbing (and the Settings screen) is ready the day those events land –
 * register an endpoint here now and the receiver in index.ts will already
 * verify its signature.
 */
import { getToken, type VisibuildCredentials, VisibuildError } from "./client";
import type { WebhookEndpoint } from "./types";

function parseEndpoint(w: any): WebhookEndpoint {
  return {
    id: String(w.id),
    url: String(w.url ?? ""),
    description: String(w.description ?? ""),
    events: Array.isArray(w.events) ? w.events.map(String) : [],
    enabled: w.enabled !== false,
    projectIds: Array.isArray(w.projectIds) ? w.projectIds.map(String) : [],
    failureCount: Number(w.failureCount ?? 0),
    createdAt: w.createdAt ?? null,
    updatedAt: w.updatedAt ?? null,
    secret: w.secret ? String(w.secret) : undefined,
  };
}

async function request(
  cfg: VisibuildCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const token = await getToken(cfg);
  const base = cfg.apiUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new VisibuildError(`Visibuild webhook API error (HTTP ${res.status}) on ${path}`, res.status, detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listWebhooks(cfg: VisibuildCredentials): Promise<WebhookEndpoint[]> {
  const data = await request(cfg, "GET", "/webhooks");
  const arr: any[] = data?.data?.webhookEndpoints ?? [];
  return arr.filter((w) => w?.id != null).map(parseEndpoint);
}

/**
 * Create an endpoint. The signing secret comes back **only** in this response
 * and cannot be retrieved again, so the caller must show it to the operator
 * once and store it if they want to verify deliveries.
 */
export async function createWebhook(
  cfg: VisibuildCredentials,
  input: { url: string; events: string[]; description?: string; projectIds?: string[] },
): Promise<WebhookEndpoint> {
  const data = await request(cfg, "POST", "/webhooks", {
    url: input.url,
    events: input.events,
    description: input.description ?? "",
    projectIds: input.projectIds ?? [],
  });
  return parseEndpoint(data?.data?.webhookEndpoint ?? {});
}

export async function deleteWebhook(cfg: VisibuildCredentials, id: string): Promise<void> {
  await request(cfg, "DELETE", `/webhooks/${encodeURIComponent(id)}`);
}

export async function setWebhookEnabled(
  cfg: VisibuildCredentials,
  id: string,
  enabled: boolean,
): Promise<WebhookEndpoint> {
  const data = await request(cfg, "PATCH", `/webhooks/${encodeURIComponent(id)}`, { enabled });
  return parseEndpoint(data?.data?.webhookEndpoint ?? {});
}
