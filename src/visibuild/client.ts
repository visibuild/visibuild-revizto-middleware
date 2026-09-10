/**
 * visibuild/client.ts – read-only Visibuild Core API client.
 *
 * Everything is fetched live over HTTPS using an OAuth 2.0 client-credentials
 * token. Tokens are cached in-memory per Worker isolate; the slow-moving
 * lookups (projects, users, companies, locations) are cached in KV as well, so
 * they survive isolate recycling and we rarely hit the rate-limited endpoints.
 *
 * Endpoints used (see https://app.apac.visibuild.com/api/docs/core/v1):
 *   POST {base}/oauth/token
 *   GET  /projects
 *   GET  /projects/{projectId}/visis ? updatedAfter & pageSize & next
 *   GET  /projects/{projectId}/visi-tags | visi-requirements | visi-status-changes
 *   GET  /projects/{projectId}/attachments | locations | location-closures
 *   GET  /projects/{projectId}/users | companies | subtypes | milestones | defect-rounds
 *   GET  /tags, /companies, /companies/{companyId}/users
 *   GET|POST|DELETE /webhooks
 */
import type {
  Company,
  DefectRound,
  Location,
  LocationClosure,
  Milestone,
  Project,
  ProjectAttachment,
  ProjectCompany,
  ProjectMilestone,
  ProjectUser,
  Subtype,
  Tag,
  User,
  Visi,
  VisiRequirement,
  VisiStatusChange,
  VisiTag,
} from "./types";

/** Just the credentials the client needs, so callers can pass a config subset. */
export interface VisibuildCredentials {
  apiUrl: string;
  oauthClientId: string;
  oauthClientSecret: string;
}

export class VisibuildError extends Error {
  status: number;
  detail: string;
  constructor(message: string, status = 0, detail = "") {
    super(message);
    this.name = "VisibuildError";
    this.status = status;
    this.detail = detail;
  }
}

/** True when Visibuild has rate-limited us and the caller should back off. */
export function isRateLimited(e: unknown): boolean {
  return e instanceof VisibuildError && e.status === 429;
}

// ---------------------------------------------------------------------------
// Pure parsers (unit-tested; tolerant of camelCase or snake_case)
// ---------------------------------------------------------------------------

function s(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Read the first present key from an object, tolerating snake_case aliases. */
function pick(o: any, ...keys: string[]): any {
  for (const k of keys) {
    if (o?.[k] !== undefined && o[k] !== null) return o[k];
  }
  return null;
}

export function tokenUrlFromApiUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/api\/core\/v1\/?$/, "").replace(/\/+$/, "");
  return `${base}/oauth/token`;
}

/** Strip the `/api/core/v1` suffix to get the web app origin, for deep links. */
export function appUrlFromApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/api\/core\/v1\/?$/, "").replace(/\/+$/, "");
}

export function parseVisi(v: any): Visi {
  return {
    id: s(v.id),
    isRoot: Boolean(pick(v, "isRoot", "is_root") ?? false),
    alias: pick(v, "alias"),
    title: s(v.title ?? ""),
    description: s(v.description ?? ""),
    type: pick(v, "type"),
    subtypeId: pick(v, "subtypeId", "subtype_id"),
    category: pick(v, "category"),
    status: s(v.status ?? ""),
    projectId: pick(v, "projectId", "project_id"),
    locationId: pick(v, "locationId", "location_id"),
    defectRoundId: pick(v, "defectRoundId", "defect_round_id"),
    projectMilestoneId: pick(v, "projectMilestoneId", "project_milestone_id"),
    assigneeId: pick(v, "assigneeId", "assignee_id"),
    assigneeType: pick(v, "assigneeType", "assignee_type"),
    createdByProjectUserId: pick(v, "createdByProjectUserId", "created_by_project_user_id"),
    replacedByVisiId: pick(v, "replacedByVisiId", "replaced_by_visi_id"),
    projectAttachmentIds: Array.isArray(pick(v, "projectAttachmentIds", "project_attachment_ids"))
      ? (pick(v, "projectAttachmentIds", "project_attachment_ids") as unknown[]).map(String)
      : [],
    dueDate: pick(v, "dueDate", "due_date"),
    holdPointSkippedAt: pick(v, "holdPointSkippedAt", "hold_point_skipped_at"),
    startedAt: pick(v, "startedAt", "started_at"),
    createdAt: pick(v, "createdAt", "created_at"),
    updatedAt: pick(v, "updatedAt", "updated_at"),
    archived: Boolean(v.archived),
  };
}

export function parseVisis(data: any): Visi[] {
  const arr: any[] = data?.data?.visis ?? [];
  return arr.filter((v) => v?.id != null).map(parseVisi);
}

export function parseProjects(data: any): Project[] {
  const arr: any[] = data?.data?.projects ?? [];
  return arr
    .filter((p) => p?.id != null)
    .map((p) => ({
      id: s(p.id),
      name: s(p.name ?? ""),
      projectIdentifier: pick(p, "projectIdentifier", "project_identifier"),
      rootLocationId: pick(p, "rootLocationId", "root_location_id"),
      address: pick(p, "address"),
      active: p.active !== false,
    }));
}

export function parseLocations(data: any): Location[] {
  const arr: any[] = data?.data?.locations ?? [];
  return arr
    .filter((l) => l?.id != null)
    .map((l) => ({ id: s(l.id), name: s(l.name ?? ""), projectId: pick(l, "projectId", "project_id") }));
}

export function parseLocationClosures(data: any): LocationClosure[] {
  const arr: any[] = data?.data?.locationClosures ?? data?.data?.location_closures ?? [];
  return arr
    .filter((c) => c?.ancestorId != null || c?.ancestor_id != null)
    .map((c) => ({
      ancestorId: s(pick(c, "ancestorId", "ancestor_id")),
      descendantId: s(pick(c, "descendantId", "descendant_id")),
      depth: Number(c.depth ?? 0),
      order: Number(c.order ?? -1),
    }));
}

export function parseProjectUsers(data: any): ProjectUser[] {
  const arr: any[] = data?.data?.projectUsers ?? data?.data?.project_users ?? [];
  return arr
    .filter((u) => u?.id != null)
    .map((u) => ({
      id: s(u.id),
      projectId: pick(u, "projectId", "project_id"),
      userId: pick(u, "userId", "user_id"),
      projectCompanyId: pick(u, "projectCompanyId", "project_company_id"),
      active: u.active !== false,
    }));
}

export function parseProjectCompanies(data: any): ProjectCompany[] {
  const arr: any[] = data?.data?.projectCompanies ?? data?.data?.project_companies ?? [];
  return arr
    .filter((c) => c?.id != null)
    .map((c) => ({
      id: s(c.id),
      projectId: pick(c, "projectId", "project_id"),
      companyId: pick(c, "companyId", "company_id"),
      active: c.active !== false,
    }));
}

export function parseUsers(data: any): User[] {
  const arr: any[] = data?.data?.users ?? data?.users ?? [];
  return arr
    .filter((u) => (u?.id ?? u?.userId ?? u?.user_id) != null)
    .map((u) => {
      const first = s(pick(u, "firstName", "first_name"));
      const last = s(pick(u, "lastName", "last_name"));
      const full = s(pick(u, "name", "fullName", "full_name") ?? `${first} ${last}`).trim();
      return {
        id: s(pick(u, "id", "userId", "user_id")),
        name: full,
        email: s(pick(u, "email", "emailAddress", "email_address")).trim().toLowerCase(),
        active: u.active !== false,
      };
    });
}

export function parseCompanies(data: any): Company[] {
  const arr: any[] = data?.data?.companies ?? [];
  return arr.filter((c) => c?.id != null).map((c) => ({ id: s(c.id), name: s(c.name ?? "") }));
}

export function parseTags(data: any): Tag[] {
  const arr: any[] = data?.data?.tags ?? [];
  return arr.filter((t) => t?.id != null).map((t) => ({
    id: s(t.id),
    name: s(t.name ?? ""),
    tagSetName: pick(t, "tagSetName", "tag_set_name"),
    order: Number(t.order ?? 0),
  }));
}

export function parseVisiTags(data: any): VisiTag[] {
  const arr: any[] = data?.data?.visiTags ?? data?.data?.visi_tags ?? [];
  return arr
    .filter((t) => (t?.visiId ?? t?.visi_id) != null)
    .map((t) => ({ visiId: s(pick(t, "visiId", "visi_id")), tagId: s(pick(t, "tagId", "tag_id")) }));
}

export function parseSubtypes(data: any): Subtype[] {
  const arr: any[] = data?.data?.subtypes ?? [];
  return arr.filter((t) => t?.id != null).map((t) => ({
    id: s(t.id),
    name: s(t.name ?? ""),
    visiCategory: pick(t, "visiCategory", "visi_category"),
  }));
}

export function parseMilestones(data: any): Milestone[] {
  const arr: any[] = data?.data?.milestones ?? [];
  return arr.filter((m) => m?.id != null).map((m) => ({
    id: s(m.id),
    name: s(m.name ?? ""),
    order: Number(m.order ?? 0),
  }));
}

export function parseProjectMilestones(data: any): ProjectMilestone[] {
  const arr: any[] = data?.data?.projectMilestones ?? data?.data?.project_milestones ?? [];
  return arr.filter((m) => m?.id != null).map((m) => ({
    id: s(m.id),
    projectId: pick(m, "projectId", "project_id"),
    milestoneId: pick(m, "milestoneId", "milestone_id"),
    archived: Boolean(m.archived),
  }));
}

export function parseDefectRounds(data: any): DefectRound[] {
  const arr: any[] = data?.data?.defectRounds ?? data?.data?.defect_rounds ?? [];
  return arr.filter((r) => r?.id != null).map((r) => ({
    id: s(r.id),
    roundName: s(pick(r, "roundName", "round_name") ?? ""),
  }));
}

export function parseVisiRequirements(data: any): VisiRequirement[] {
  const arr: any[] = data?.data?.visiRequirements ?? data?.data?.visi_requirements ?? [];
  return arr
    .filter((r) => r?.id != null)
    .map((r) => ({
      id: s(r.id),
      visiId: s(pick(r, "visiId", "visi_id")),
      type: s(r.type ?? ""),
      order: Number(r.order ?? 0),
      title: s(r.title ?? ""),
      value: r.value ?? null,
      choices: Array.isArray(r.choices) ? r.choices.map(String) : null,
      allowMultiple: Boolean(pick(r, "allowMultiple", "allow_multiple")),
      values: Array.isArray(r.values) ? r.values.map(String) : null,
      updatedAt: pick(r, "updatedAt", "updated_at"),
    }));
}

export function parseProjectAttachments(data: any): ProjectAttachment[] {
  const arr: any[] = data?.data?.projectAttachments ?? data?.data?.project_attachments ?? data?.data?.attachments ?? [];
  return arr
    .filter((a) => a?.id != null && a?.url)
    .map((a) => ({
      id: s(a.id),
      title: s(a.title ?? ""),
      description: s(a.description ?? ""),
      url: s(a.url),
      projectId: pick(a, "projectId", "project_id"),
      createdAt: pick(a, "createdAt", "created_at"),
      updatedAt: pick(a, "updatedAt", "updated_at"),
    }));
}

export function parseVisiStatusChanges(data: any): VisiStatusChange[] {
  const arr: any[] = data?.data?.visiStatusChanges ?? data?.data?.visi_status_changes ?? [];
  return arr
    .filter((c) => c?.id != null)
    .map((c) => ({
      id: s(c.id),
      visiId: s(pick(c, "visiId", "visi_id")),
      projectUserId: pick(c, "projectUserId", "project_user_id"),
      event: s(c.event ?? ""),
      comment: c.comment ?? null,
      statusBefore: pick(c, "statusBefore", "status_before"),
      statusAfter: pick(c, "statusAfter", "status_after"),
      timestamp: pick(c, "timestamp"),
    }));
}

// ---------------------------------------------------------------------------
// Token cache (best-effort, per isolate)
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  exp: number;
}
const tokenCache = new Map<string, CachedToken>();
const TOKEN_MARGIN = 60;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function credKey(cfg: VisibuildCredentials): string {
  return `${cfg.apiUrl}|${cfg.oauthClientId}`;
}

/** Drop the cached OAuth token (used when credentials change, and by tests). */
export function resetTokenCache(): void {
  tokenCache.clear();
}

export async function getToken(cfg: VisibuildCredentials): Promise<string> {
  const key = credKey(cfg);
  const cached = tokenCache.get(key);
  if (cached && cached.exp - TOKEN_MARGIN > now()) return cached.token;

  const res = await fetch(tokenUrlFromApiUrl(cfg.apiUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.oauthClientId,
      client_secret: cfg.oauthClientSecret,
      scope: "read",
    }).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new VisibuildError(`OAuth token request failed (HTTP ${res.status})`, res.status, detail);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new VisibuildError("OAuth response did not contain an access token", res.status);
  }
  tokenCache.set(key, { token: data.access_token, exp: now() + (data.expires_in ?? 3600) });
  return data.access_token;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export async function apiGet(
  cfg: VisibuildCredentials,
  path: string,
  token: string,
  sp?: URLSearchParams,
): Promise<any> {
  const base = cfg.apiUrl.replace(/\/+$/, "");
  const qs = sp && [...sp.keys()].length ? `?${sp.toString()}` : "";
  const res = await fetch(`${base}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new VisibuildError(`Visibuild API error (HTTP ${res.status}) on ${path}`, res.status, detail);
  }
  return res.json();
}

export interface PaginateOptions {
  pageSize?: number;
  /** ISO 8601 timestamp; only records updated after this are returned. */
  updatedAfter?: string | null;
  /** Stop after this many pages, to bound a single Worker invocation. */
  maxPages?: number;
}

/** Walk seek-based pagination, collecting each page's items via `pick`. */
export async function paginate<T>(
  cfg: VisibuildCredentials,
  path: string,
  token: string,
  parse: (data: any) => T[],
  opts: PaginateOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  const pageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? 100;
  let next: string | null = null;
  let pages = 0;
  do {
    const sp = new URLSearchParams({ pageSize: String(pageSize) });
    if (opts.updatedAfter) sp.set("updatedAfter", opts.updatedAfter);
    if (next) sp.set("next", next);
    const data = await apiGet(cfg, path, token, sp);
    out.push(...parse(data));
    next = data?.pagination?.next ?? null;
    pages++;
  } while (next && pages < maxPages);
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function testConnection(cfg: VisibuildCredentials): Promise<{ ok: boolean; message: string }> {
  try {
    await getToken(cfg);
    return { ok: true, message: "Connected to Visibuild successfully." };
  } catch (e) {
    if (e instanceof VisibuildError) {
      return { ok: false, message: e.detail ? `${e.message}: ${e.detail.slice(0, 200)}` : e.message };
    }
    return { ok: false, message: (e as Error).message || "Connection failed" };
  }
}

export async function listProjects(cfg: VisibuildCredentials): Promise<Project[]> {
  const token = await getToken(cfg);
  const projects = await paginate(cfg, "/projects", token, parseProjects, { pageSize: 500 });
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

const p = (id: string) => encodeURIComponent(id);

/** Visis for one project, optionally only those updated after a watermark. */
export async function listVisis(
  cfg: VisibuildCredentials,
  projectId: string,
  opts: PaginateOptions = {},
): Promise<Visi[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/visis`, token, parseVisis, {
    pageSize: 1000,
    ...opts,
  });
}

export async function listLocations(cfg: VisibuildCredentials, projectId: string): Promise<Location[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/locations`, token, parseLocations, { pageSize: 500 });
}

export async function listLocationClosures(
  cfg: VisibuildCredentials,
  projectId: string,
): Promise<LocationClosure[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/location-closures`, token, parseLocationClosures, {
    pageSize: 1000,
  });
}

export async function listProjectUsers(cfg: VisibuildCredentials, projectId: string): Promise<ProjectUser[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/users`, token, parseProjectUsers, { pageSize: 500 });
}

export async function listProjectCompanies(
  cfg: VisibuildCredentials,
  projectId: string,
): Promise<ProjectCompany[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/companies`, token, parseProjectCompanies, { pageSize: 500 });
}

export async function listCompanies(cfg: VisibuildCredentials): Promise<Company[]> {
  const token = await getToken(cfg);
  return paginate(cfg, "/companies", token, parseCompanies, { pageSize: 500 });
}

export async function listCompanyUsers(cfg: VisibuildCredentials, companyId: string): Promise<User[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/companies/${p(companyId)}/users`, token, parseUsers, { pageSize: 200 });
}

export async function listTags(cfg: VisibuildCredentials): Promise<Tag[]> {
  const token = await getToken(cfg);
  return paginate(cfg, "/tags", token, parseTags, { pageSize: 500 });
}

export async function listVisiTags(
  cfg: VisibuildCredentials,
  projectId: string,
  opts: PaginateOptions = {},
): Promise<VisiTag[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/visi-tags`, token, parseVisiTags, {
    pageSize: 1000,
    ...opts,
  });
}

export async function listSubtypes(cfg: VisibuildCredentials, projectId: string): Promise<Subtype[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/subtypes`, token, parseSubtypes, { pageSize: 500 });
}

export async function listProjectMilestones(
  cfg: VisibuildCredentials,
  projectId: string,
): Promise<ProjectMilestone[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/milestones`, token, parseProjectMilestones, { pageSize: 500 });
}

export async function listMilestones(cfg: VisibuildCredentials): Promise<Milestone[]> {
  const token = await getToken(cfg);
  return paginate(cfg, "/milestones", token, parseMilestones, { pageSize: 500 });
}

export async function listDefectRounds(cfg: VisibuildCredentials, projectId: string): Promise<DefectRound[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/defect-rounds`, token, parseDefectRounds, { pageSize: 500 });
}

export async function listVisiRequirements(
  cfg: VisibuildCredentials,
  projectId: string,
  opts: PaginateOptions = {},
): Promise<VisiRequirement[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/visi-requirements`, token, parseVisiRequirements, {
    pageSize: 1000,
    ...opts,
  });
}

export async function listProjectAttachments(
  cfg: VisibuildCredentials,
  projectId: string,
  opts: PaginateOptions = {},
): Promise<ProjectAttachment[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/attachments`, token, parseProjectAttachments, {
    pageSize: 500,
    ...opts,
  });
}

/** Fetch a single ProjectAttachment, for the ids a visi references directly. */
export async function getProjectAttachment(
  cfg: VisibuildCredentials,
  projectId: string,
  attachmentId: string,
): Promise<ProjectAttachment | null> {
  const token = await getToken(cfg);
  const data = await apiGet(cfg, `/projects/${p(projectId)}/attachments/${p(attachmentId)}`, token);
  const a = data?.data?.projectAttachment ?? data?.data?.attachment ?? null;
  return a ? parseProjectAttachments({ data: { projectAttachments: [a] } })[0] ?? null : null;
}

export async function listVisiStatusChanges(
  cfg: VisibuildCredentials,
  projectId: string,
  opts: PaginateOptions = {},
): Promise<VisiStatusChange[]> {
  const token = await getToken(cfg);
  return paginate(cfg, `/projects/${p(projectId)}/visi-status-changes`, token, parseVisiStatusChanges, {
    pageSize: 1000,
    ...opts,
  });
}
