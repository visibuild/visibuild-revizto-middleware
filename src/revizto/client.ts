/**
 * revizto/client.ts – Revizto 5 API client.
 *
 * Two habits the Revizto API forces on every caller:
 *
 *  1. **HTTP 200 is not success.** Handled errors come back as 200 with a
 *     negative `result` and a human-readable `message`. `call()` below is the
 *     only place that unwraps the envelope, so nothing else has to remember.
 *  2. **Issues are created whole and edited by diff.** `createIssue` posts the
 *     full field set; `addComments` carries both text/file comments and the
 *     `diff` comments that actually change fields.
 */
import type { Env } from "../env";
import { getAccessToken, ReviztoAuthError, type ClientCredentials } from "./oauth";
import {
  regionHost,
  type LocationProperties,
  type ManagedFields,
  type ReviztoIssue,
  type ReviztoIssueStatus,
  type ReviztoIssueType,
  type ReviztoLicense,
  type ReviztoMember,
  type ReviztoProject,
  type ReviztoWorkflowSettings,
} from "./types";

export class ReviztoApiError extends Error {
  /** Revizto's own result code (0 is success; negatives are errors). */
  result: number;
  /** HTTP status, for transport-level failures. */
  status: number;
  constructor(message: string, result = 0, status = 200) {
    super(message);
    this.name = "ReviztoApiError";
    this.result = result;
    this.status = status;
  }
}

/**
 * Result codes that mean "this token is no good": -204 the account no longer
 * provides API access, -205 the token belongs to another region, -206 the token
 * is invalid or expired.
 */
export function isTokenResult(result: number): boolean {
  return result === -204 || result === -205 || result === -206;
}

export interface ReviztoConnection extends ClientCredentials {
  region: string;
}

interface CallOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined>;
  /** Sent as multipart/form-data, which is what issue/add and comment/add want. */
  form?: FormData;
}

async function call<T>(
  env: Env,
  conn: ReviztoConnection,
  path: string,
  opts: CallOptions = {},
): Promise<T> {
  const token = await getAccessToken(env, conn);
  const url = new URL(`${regionHost(conn.region)}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    body: opts.form,
  });

  let body: { result?: number; data?: unknown; message?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new ReviztoApiError(`Revizto returned HTTP ${res.status} with no JSON body (${path}).`, 0, res.status);
  }

  if (!res.ok) {
    throw new ReviztoApiError(body.message || `Revizto API error (HTTP ${res.status}) on ${path}`, body.result ?? 0, res.status);
  }
  const result = body.result ?? 0;
  if (result !== 0) {
    // An expired or foreign-region token is an auth problem, not an API one –
    // raise it as such so the dashboard can offer a Reconnect.
    if (isTokenResult(result)) {
      throw new ReviztoAuthError(body.message || `Revizto rejected the access token (result ${result}).`, result !== -206);
    }
    throw new ReviztoApiError(body.message || `Revizto returned result ${result} on ${path}`, result, res.status);
  }
  return body.data as T;
}

// ---------------------------------------------------------------------------
// Identity, licences and projects
// ---------------------------------------------------------------------------

export async function getCurrentUser(
  env: Env,
  conn: ReviztoConnection,
): Promise<{ email: string; name: string; uuid: string }> {
  const data = await call<any>(env, conn, "/v5/user");
  const first = String(data?.firstname ?? "");
  const last = String(data?.lastname ?? "");
  return {
    email: String(data?.email ?? "").trim().toLowerCase(),
    name: String(data?.fullname ?? `${first} ${last}`).trim(),
    uuid: String(data?.uuid ?? ""),
  };
}

export async function listLicenses(env: Env, conn: ReviztoConnection): Promise<ReviztoLicense[]> {
  const data = await call<any>(env, conn, "/v5/user/licenses");
  const arr: any[] = Array.isArray(data) ? data : (data?.entities ?? data?.data ?? []);
  return arr
    .filter((l) => l?.uuid)
    .map((l) => ({
      uuid: String(l.uuid),
      name: String(l.name ?? l.title ?? l.company ?? l.uuid),
      accountUuid: l.accountUuid ? String(l.accountUuid) : null,
    }));
}

/** Every project in a licence, walking the paged endpoint to the end. */
export async function listProjects(
  env: Env,
  conn: ReviztoConnection,
  licenseUuid: string,
): Promise<ReviztoProject[]> {
  const out: ReviztoProject[] = [];
  const limit = 100;
  let page = 0;
  let pages = 1;
  do {
    const data = await call<any>(env, conn, `/v5/project/list/${encodeURIComponent(licenseUuid)}/paged`, {
      query: { page, limit, screenshots: 0, avatars: 0, notifications: 0 },
    });
    const arr: any[] = data?.data ?? data?.entities ?? [];
    for (const p of arr) {
      if (p?.uuid == null || p?.id == null) continue;
      out.push({
        id: Number(p.id),
        uuid: String(p.uuid),
        title: String(p.title ?? ""),
        archived: Boolean(p.archived),
      });
    }
    pages = Number(data?.pages ?? 1);
    page++;
  } while (page < pages && page < 50);
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// Workflow settings (issue types and statuses) and project members
// ---------------------------------------------------------------------------

export async function getWorkflowSettings(
  env: Env,
  conn: ReviztoConnection,
  projectUuid: string,
): Promise<ReviztoWorkflowSettings> {
  const data = await call<any>(
    env,
    conn,
    `/v5/project/${encodeURIComponent(projectUuid)}/issue-workflow/settings`,
  );
  const types: ReviztoIssueType[] = (data?.types ?? [])
    .filter((t: any) => t?.uuid)
    .map((t: any) => ({
      uuid: String(t.uuid),
      name: String(t.name ?? ""),
      isDefault: Boolean(t.isDefault),
      isActive: t.isActive !== false,
      deleted: Boolean(t.deletedAt),
      workflowUuid: t.workflowUuid ? String(t.workflowUuid) : null,
    }));
  const statuses: ReviztoIssueStatus[] = (data?.statuses ?? [])
    .filter((s: any) => s?.uuid)
    .map((s: any) => ({
      uuid: String(s.uuid),
      name: String(s.name ?? ""),
      category: String(s.category ?? ""),
      deleted: Boolean(s.deletedAt),
    }));
  return {
    types: types.filter((t) => !t.deleted && t.isActive),
    statuses: statuses.filter((s) => !s.deleted),
  };
}

export async function listMembers(
  env: Env,
  conn: ReviztoConnection,
  projectUuid: string,
): Promise<ReviztoMember[]> {
  const data = await call<any>(env, conn, `/v5/project/${encodeURIComponent(projectUuid)}/team`);
  const arr: any[] = Array.isArray(data) ? data : (data?.entities ?? data?.data ?? []);
  return arr
    .filter((m) => m?.email)
    .map((m) => ({
      email: String(m.email).trim().toLowerCase(),
      fullname: String(m.fullname ?? `${m.firstname ?? ""} ${m.lastname ?? ""}`).trim(),
      uuid: m.uuid ? String(m.uuid) : null,
      company: m.company ? String(m.company) : null,
      frozen: Boolean(m.frozen),
    }))
    .sort((a, b) => (a.fullname || a.email).localeCompare(b.fullname || b.email));
}

// ---------------------------------------------------------------------------
// Reading issues
// ---------------------------------------------------------------------------

/** Pull `{ value }` out of a Revizto issue field, tolerating nulls. */
function fieldValue(f: any): any {
  return f && typeof f === "object" && "value" in f ? f.value : undefined;
}

export function parseIssue(raw: any): ReviztoIssue | null {
  if (!raw?.uuid) return null;
  const fields: Partial<ManagedFields> = {};
  const title = fieldValue(raw.title);
  if (title !== undefined) fields.title = String(title ?? "");
  const customStatus = fieldValue(raw.customStatus);
  if (customStatus !== undefined) fields.customStatus = String(customStatus ?? "");
  const customType = fieldValue(raw.customType);
  if (customType !== undefined) fields.customType = String(customType ?? "");
  const assignee = fieldValue(raw.assignee);
  if (assignee !== undefined) fields.assignee = String(assignee ?? "").toLowerCase();
  const reporter = fieldValue(raw.reporter);
  if (reporter !== undefined) fields.reporter = String(reporter ?? "").toLowerCase();
  const deadline = fieldValue(raw.deadline);
  if (deadline !== undefined) fields.deadline = String(deadline ?? "");
  const priority = fieldValue(raw.priority);
  if (priority !== undefined) fields.priority = String(priority ?? "none") as ManagedFields["priority"];
  const tags = fieldValue(raw.tags);
  if (Array.isArray(tags)) fields.tags = tags.map(String);
  const visibility = fieldValue(raw.visibility);
  if (visibility !== undefined) fields.visibility = Number(visibility ?? 1);

  return {
    uuid: String(raw.uuid),
    id: raw.id == null ? null : Number(raw.id),
    fields,
    updated: raw.updated ? String(raw.updated) : null,
  };
}

export interface IssueSweep {
  issues: ReviztoIssue[];
  /** The watermark to pass as `synchronized` on the next sweep. */
  synchronized: string | null;
  /** True when the sweep stopped at the page cap rather than the end. */
  truncated: boolean;
}

/**
 * Every issue created or updated since `synchronized` ("YYYY-MM-DD HH:MM:SS"),
 * with all fields. This is how we learn the *current* value of a field before
 * building a diff – Revizto has no "get one issue by UUID" endpoint.
 *
 * Pass `synchronized: null` for a first run; that returns the whole project,
 * which is exactly what a fresh pair wants.
 */
export async function sweepIssues(
  env: Env,
  conn: ReviztoConnection,
  projectUuid: string,
  synchronized: string | null,
  maxPages = 25,
): Promise<IssueSweep> {
  const issues: ReviztoIssue[] = [];
  const limit = 100;
  let page = 0;
  let pages = 1;
  let watermark: string | null = null;

  do {
    const data = await call<any>(
      env,
      conn,
      `/v5/project/${encodeURIComponent(projectUuid)}/issue-filter/filter`,
      {
        query: {
          page,
          limit,
          sendFullIssueData: true,
          synchronized: synchronized ?? undefined,
        },
      },
    );
    for (const raw of data?.data ?? []) {
      const issue = parseIssue(raw);
      if (issue) issues.push(issue);
    }
    pages = Number(data?.pages ?? 1);
    if (data?.synchronized) watermark = String(data.synchronized);
    page++;
  } while (page < pages && page < maxPages);

  return { issues, synchronized: watermark, truncated: page >= maxPages && page < pages };
}

// ---------------------------------------------------------------------------
// Writing issues
// ---------------------------------------------------------------------------

/** Wrap a scalar as Revizto's `{ value, timestamp }` field envelope. */
function field(value: unknown, timestamp?: string): { value: unknown; timestamp?: string } {
  return timestamp ? { value, timestamp } : { value };
}

export interface CreateIssueInput {
  /** Client-generated v4 UUID. We reuse the visi's id where it qualifies. */
  uuid: string;
  /** The integer Revizto project id, not the UUID. */
  projectId: number;
  fields: ManagedFields;
  /** Revizto's creation timestamp, "YYYY-MM-DD HH:MM:SS". */
  created?: string;
  /** Location tags. Settable at creation only – there is no diff for these. */
  location?: LocationProperties;
}

/**
 * Create an issue. The body is multipart/form-data with `fields` carried as a
 * JSON string part; `preview` (the markup image) is left off, which gives a
 * plain issue with no markup.
 */
export async function createIssue(
  env: Env,
  conn: ReviztoConnection,
  input: CreateIssueInput,
): Promise<void> {
  const f: Record<string, unknown> = {
    title: field(input.fields.title),
    customStatus: field(input.fields.customStatus),
    customType: field(input.fields.customType),
    priority: field(input.fields.priority),
    visibility: field(input.fields.visibility),
    tags: field(input.fields.tags),
  };
  if (input.fields.assignee) f.assignee = field(input.fields.assignee);
  if (input.fields.reporter) f.reporter = field(input.fields.reporter);
  if (input.fields.deadline) f.deadline = field(input.fields.deadline);
  if (input.created) f.created = field(input.created);
  if (input.location && Object.values(input.location).some(Boolean)) {
    f.locationPropertiesJson = input.location;
  }

  const form = new FormData();
  form.set("uuid", input.uuid);
  form.set("projectId", String(input.projectId));
  form.set("operationId", crypto.randomUUID().replace(/-/g, ""));
  form.set("fields", JSON.stringify(f));

  await call(env, conn, "/v5/issue/add", { method: "POST", form });
}

/** A comment that changes issue fields. Revizto drops any pair whose `old` is wrong. */
export type FieldDiff = Partial<Record<keyof ManagedFields, { old: unknown; new: unknown }>>;

export type IssueComment =
  | { kind: "text"; uuid: string; text: string; reporter?: string; created?: string }
  | { kind: "diff"; uuid: string; diff: FieldDiff; reporter?: string; created?: string }
  | { kind: "file"; uuid: string; filename: string; blob: Blob; reporter?: string; created?: string };

function commentPayload(c: IssueComment): Record<string, unknown> {
  const base: Record<string, unknown> = { uuid: c.uuid };
  if (c.reporter) base.reporter = c.reporter;
  if (c.created) base.created = c.created;
  if (c.kind === "text") return { ...base, type: "text", text: c.text };
  if (c.kind === "diff") return { ...base, type: "diff", diff: c.diff };
  return { ...base, type: "file" };
}

/**
 * Post one or more comments to an issue. Text comments are commentary; `diff`
 * comments are how field edits are made; `file` comments are attachments, whose
 * bytes ride along in a `file_<comment uuid>` part.
 */
export async function addComments(
  env: Env,
  conn: ReviztoConnection,
  args: { projectUuid: string; projectId: number; issueUuid: string; comments: IssueComment[] },
): Promise<void> {
  if (args.comments.length === 0) return;

  const form = new FormData();
  form.set("projectUuid", args.projectUuid);
  form.set("projectId", String(args.projectId));
  form.set("issueUuid", args.issueUuid);
  form.set("comments", JSON.stringify(args.comments.map(commentPayload)));
  for (const c of args.comments) {
    if (c.kind === "file") form.set(`file_${c.uuid}`, c.blob, c.filename);
  }

  await call(env, conn, "/v5/comment/add", { method: "POST", form });
}

/** Cheap connectivity check for the dashboard. */
export async function testConnection(
  env: Env,
  conn: ReviztoConnection,
): Promise<{ ok: boolean; message: string }> {
  try {
    const user = await getCurrentUser(env, conn);
    return { ok: true, message: `Connected to Revizto as ${user.name || user.email}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message || "Connection failed" };
  }
}
