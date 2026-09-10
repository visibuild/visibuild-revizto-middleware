/**
 * config.ts – editable configuration, stored in KV.
 *
 * Two documents, deliberately separate:
 *
 *  - `config` – one JSON blob: API credentials, global sync scope, content
 *    options, run caps, access and branding.
 *  - `mapping:<pairId>` – one per project pair: how a visi's users, locations,
 *    statuses, types and tags become Revizto values.
 *
 * Revizto's OAuth tokens live under their own key again (see revizto/oauth.ts),
 * so saving Settings can never clobber a token the cron has just rotated.
 *
 * Everything loaded here is run through a normaliser, because a stored document
 * may predate the current shape or have been hand-edited.
 */
import type { Env } from "./env";
import { LOCATION_FIELDS, REVIZTO_PRIORITIES, type LocationField, type ReviztoPriority } from "./revizto/types";
import { VISI_CATEGORIES, VISI_STATUSES, VISI_TYPES } from "./visibuild/types";

// ---------------------------------------------------------------------------
// Global config
// ---------------------------------------------------------------------------

/** Which visis are eligible to sync. Empty arrays mean "no restriction". */
export interface SyncFilters {
  categories: string[];
  types: string[];
  statuses: string[];
  /** Archived visis are excluded by default. */
  includeArchived: boolean;
  /** Root visis only – the children of an inspection are usually noise in Revizto. */
  rootOnly: boolean;
}

/** What gets carried across as comments, over and above the mapped fields. */
export interface ContentOptions {
  description: boolean;
  attachments: boolean;
  requirements: boolean;
  statusHistory: boolean;
  /** Append a deep link back to the visi on the first comment. */
  backLink: boolean;
}

/** Per-run work caps, so one invocation always finishes inside the CPU budget. */
export interface SyncLimits {
  visisPerRun: number;
  attachmentsPerRun: number;
  maxAttachmentMb: number;
}

export interface AppConfig {
  /** Visibuild API base URL, e.g. https://app.apac.visibuild.com/api/core/v1 */
  visibuildApiUrl: string;
  visibuildClientId: string;
  visibuildClientSecret: string;

  /** Revizto region id, e.g. "sydney". Regions are fully independent. */
  reviztoRegion: string;
  reviztoClientId: string;
  reviztoClientSecret: string;

  filters: SyncFilters;
  content: ContentOptions;
  limits: SyncLimits;

  /** Password for read-only access to the dashboard and run history. */
  viewerPassword: string;

  brandLabel: string;
  logoUrl: string;
  faviconUrl: string;
  primaryColor: string;
}

export const DEFAULT_PRIMARY = "#5c7e6a";
export const DEFAULT_BRAND = "Visibuild → Revizto";
const FALLBACK_API_URL = "https://app.apac.visibuild.com/api/core/v1";
const CONFIG_KEY = "config";
const MAPPING_PREFIX = "mapping:";

export function defaultFilters(): SyncFilters {
  return { categories: [], types: [], statuses: [], includeArchived: false, rootOnly: true };
}

export function defaultContent(): ContentOptions {
  return { description: true, attachments: true, requirements: true, statusHistory: true, backLink: true };
}

export function defaultLimits(): SyncLimits {
  return { visisPerRun: 200, attachmentsPerRun: 50, maxAttachmentMb: 32 };
}

export function defaultConfig(env: Env): AppConfig {
  return {
    visibuildApiUrl: env.DEFAULT_VISIBUILD_API_URL || FALLBACK_API_URL,
    visibuildClientId: "",
    visibuildClientSecret: "",
    reviztoRegion: "sydney",
    reviztoClientId: "",
    reviztoClientSecret: "",
    filters: defaultFilters(),
    content: defaultContent(),
    limits: defaultLimits(),
    viewerPassword: "",
    brandLabel: DEFAULT_BRAND,
    logoUrl: "",
    faviconUrl: "",
    primaryColor: DEFAULT_PRIMARY,
  };
}

/** Keep only the strings that appear in `allowed`, de-duplicated. */
function allowList(stored: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(stored)) return [];
  const set = new Set(allowed);
  return [...new Set(stored.map(String).filter((v) => set.has(v)))];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeFilters(stored: unknown): SyncFilters {
  const base = defaultFilters();
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Partial<SyncFilters>;
  return {
    categories: allowList(s.categories, VISI_CATEGORIES),
    // Visi types are an open vocabulary in the API, so keep whatever was saved.
    types: Array.isArray(s.types) ? [...new Set(s.types.map(String))] : [],
    statuses: allowList(s.statuses, VISI_STATUSES),
    includeArchived: Boolean(s.includeArchived),
    rootOnly: s.rootOnly !== false,
  };
}

function normalizeContent(stored: unknown): ContentOptions {
  const base = defaultContent();
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Partial<ContentOptions>;
  return {
    description: s.description !== false,
    attachments: s.attachments !== false,
    requirements: s.requirements !== false,
    statusHistory: s.statusHistory !== false,
    backLink: s.backLink !== false,
  };
}

function normalizeLimits(stored: unknown): SyncLimits {
  const base = defaultLimits();
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Partial<SyncLimits>;
  return {
    visisPerRun: clampInt(s.visisPerRun, 1, 2000, base.visisPerRun),
    attachmentsPerRun: clampInt(s.attachmentsPerRun, 0, 500, base.attachmentsPerRun),
    maxAttachmentMb: clampInt(s.maxAttachmentMb, 1, 38, base.maxAttachmentMb),
  };
}

/**
 * This Worker previously hosted a Visibuild tickets portal, and a live KV store
 * may still hold that config. The Visibuild credentials are the same ones this
 * app needs – only the key names changed – so carry them over rather than
 * making the operator dig them out again.
 */
function legacyVisibuildCredentials(stored: Record<string, unknown>): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  if (typeof stored.apiUrl === "string" && stored.apiUrl) out.visibuildApiUrl = stored.apiUrl;
  if (typeof stored.oauthClientId === "string" && stored.oauthClientId) out.visibuildClientId = stored.oauthClientId;
  if (typeof stored.oauthClientSecret === "string" && stored.oauthClientSecret) {
    out.visibuildClientSecret = stored.oauthClientSecret;
  }
  return out;
}

const STRING_KEYS = [
  "visibuildApiUrl",
  "visibuildClientId",
  "visibuildClientSecret",
  "reviztoRegion",
  "reviztoClientId",
  "reviztoClientSecret",
  "viewerPassword",
  "brandLabel",
  "logoUrl",
  "faviconUrl",
  "primaryColor",
] as const satisfies readonly (keyof AppConfig)[];

export async function loadConfig(env: Env): Promise<AppConfig> {
  const base = defaultConfig(env);
  const raw = await env.CONFIG.get(CONFIG_KEY);
  if (!raw) return base;

  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return base;
  }

  // Copy known keys only, so a document written by an earlier version of this
  // app cannot smuggle dead fields into everything we save from here on.
  const next: AppConfig = { ...base, ...legacyVisibuildCredentials(stored) };
  for (const key of STRING_KEYS) {
    const value = stored[key];
    if (typeof value === "string") next[key] = value;
  }
  next.filters = normalizeFilters(stored.filters);
  next.content = normalizeContent(stored.content);
  next.limits = normalizeLimits(stored.limits);
  return next;
}

export async function saveConfig(env: Env, patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig(env);
  const next: AppConfig = { ...current, ...patch };
  await env.CONFIG.put(CONFIG_KEY, JSON.stringify(next));
  return next;
}

/** True once the Visibuild connection can be attempted. */
export function hasVisibuildCredentials(cfg: AppConfig): boolean {
  return Boolean(cfg.visibuildApiUrl && cfg.visibuildClientId && cfg.visibuildClientSecret);
}

/** True once the Revizto OAuth flow can be started. */
export function hasReviztoCredentials(cfg: AppConfig): boolean {
  return Boolean(cfg.reviztoRegion && cfg.reviztoClientId && cfg.reviztoClientSecret);
}

/** The credential subset the Visibuild client takes. */
export function visibuildCredentials(cfg: AppConfig) {
  return {
    apiUrl: cfg.visibuildApiUrl,
    oauthClientId: cfg.visibuildClientId,
    oauthClientSecret: cfg.visibuildClientSecret,
  };
}

/** The credential subset the Revizto client takes. */
export function reviztoConnection(cfg: AppConfig) {
  return {
    region: cfg.reviztoRegion,
    clientId: cfg.reviztoClientId,
    clientSecret: cfg.reviztoClientSecret,
  };
}

// ---------------------------------------------------------------------------
// Per-pair mapping
// ---------------------------------------------------------------------------

/**
 * Which extra tags to derive from a visi's own metadata. These matter more than
 * they look: a Revizto issue's location tags cannot be changed after creation,
 * so writing the location path as a tag is the only way a visi that later moves
 * shows the move on the Revizto side.
 */
export interface DerivedTags {
  type: boolean;
  category: boolean;
  subtype: boolean;
  milestone: boolean;
  defectRound: boolean;
  location: boolean;
  alias: boolean;
}

export const DERIVED_TAG_LABELS: Record<keyof DerivedTags, string> = {
  type: "Visi type",
  category: "Visi category",
  subtype: "Subtype",
  milestone: "Milestone",
  defectRound: "Defect round",
  location: "Location path",
  alias: "Visi alias",
};

export interface PairMapping {
  /** Title template. `{alias}`, `{title}`, `{type}`, `{location}` are substituted. */
  titleTemplate: string;

  /** Visi status -> Revizto issue status UUID. */
  statuses: Record<string, string>;
  /** Fallback status UUID for a visi status with no mapping. */
  defaultStatus: string;

  /**
   * Visi type/category/subtype -> Revizto issue type UUID. Keys are namespaced
   * (`subtype:<uuid>`, `type:<name>`, `category:<name>`) and consulted in that
   * order, so a subtype rule beats a type rule beats a category rule.
   */
  types: Record<string, string>;
  defaultType: string;

  /** Visibuild ProjectUser id -> Revizto member email. */
  users: Record<string, string>;
  /** Visibuild ProjectCompany id -> Revizto member email, for company-assigned visis. */
  companies: Record<string, string>;
  /** Used when neither the user nor the company map resolves. */
  defaultAssignee: string;
  /** Used when the visi's creator does not map to a Revizto member. */
  defaultReporter: string;

  /** Location tree depth (as a string key) -> Revizto location field. */
  locationDepths: Record<string, LocationField | "">;
  /** Per-location overrides, for the locations that do not fit the depth rule. */
  locationOverrides: Record<string, Partial<Record<LocationField, string>>>;

  /** Copy the visi's own Visibuild tags across. */
  tagPassthrough: boolean;
  /** Optional prefix on every tag written, e.g. "vb:". */
  tagPrefix: string;
  derivedTags: DerivedTags;

  /** Visi type/category -> Revizto priority, same namespaced key scheme as `types`. */
  priorityRules: Record<string, ReviztoPriority>;
  defaultPriority: ReviztoPriority;

  /** 1 = visible to the project, 0 = author, reporter, assignee and watchers only. */
  visibility: number;

  /** Per-pair scope override; null inherits the global filters. */
  filters: SyncFilters | null;
}

export function defaultDerivedTags(): DerivedTags {
  return {
    type: true,
    category: false,
    subtype: true,
    milestone: false,
    defectRound: false,
    location: true,
    alias: false,
  };
}

export function defaultMapping(): PairMapping {
  return {
    titleTemplate: "{alias} {title}",
    statuses: {},
    defaultStatus: "",
    types: {},
    defaultType: "",
    users: {},
    companies: {},
    defaultAssignee: "",
    defaultReporter: "",
    // A sensible starting shape for a building: tower / level / room.
    locationDepths: { "1": "area", "2": "level", "3": "room" },
    locationOverrides: {},
    tagPassthrough: true,
    tagPrefix: "",
    derivedTags: defaultDerivedTags(),
    priorityRules: {},
    defaultPriority: "none",
    visibility: 1,
    filters: null,
  };
}

/** Keep only string -> string entries, dropping blanks. */
function stringMap(stored: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!stored || typeof stored !== "object") return out;
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

function normalizeLocationDepths(stored: unknown): Record<string, LocationField | ""> {
  const out: Record<string, LocationField | ""> = {};
  if (!stored || typeof stored !== "object") return defaultMapping().locationDepths;
  const allowed = new Set<string>(LOCATION_FIELDS);
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!/^\d+$/.test(k)) continue;
    out[k] = typeof v === "string" && allowed.has(v) ? (v as LocationField) : "";
  }
  return out;
}

function normalizeLocationOverrides(stored: unknown): PairMapping["locationOverrides"] {
  const out: PairMapping["locationOverrides"] = {};
  if (!stored || typeof stored !== "object") return out;
  for (const [locationId, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry: Partial<Record<LocationField, string>> = {};
    for (const f of LOCATION_FIELDS) {
      const v = (value as Record<string, unknown>)[f];
      if (typeof v === "string" && v.trim()) entry[f] = v.trim();
    }
    if (Object.keys(entry).length) out[locationId] = entry;
  }
  return out;
}

function normalizePriorityRules(stored: unknown): Record<string, ReviztoPriority> {
  const out: Record<string, ReviztoPriority> = {};
  if (!stored || typeof stored !== "object") return out;
  const allowed = new Set<string>(REVIZTO_PRIORITIES);
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof v === "string" && allowed.has(v)) out[k] = v as ReviztoPriority;
  }
  return out;
}

function normalizeDerivedTags(stored: unknown): DerivedTags {
  const base = defaultDerivedTags();
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Record<string, unknown>;
  const out = {} as DerivedTags;
  for (const key of Object.keys(base) as (keyof DerivedTags)[]) {
    out[key] = typeof s[key] === "boolean" ? (s[key] as boolean) : base[key];
  }
  return out;
}

export function normalizeMapping(stored: unknown): PairMapping {
  const base = defaultMapping();
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Partial<PairMapping>;
  const priority = REVIZTO_PRIORITIES.includes(s.defaultPriority as ReviztoPriority)
    ? (s.defaultPriority as ReviztoPriority)
    : base.defaultPriority;
  return {
    titleTemplate: typeof s.titleTemplate === "string" && s.titleTemplate.trim() ? s.titleTemplate : base.titleTemplate,
    statuses: stringMap(s.statuses),
    defaultStatus: typeof s.defaultStatus === "string" ? s.defaultStatus.trim() : "",
    types: stringMap(s.types),
    defaultType: typeof s.defaultType === "string" ? s.defaultType.trim() : "",
    users: stringMap(s.users),
    companies: stringMap(s.companies),
    defaultAssignee: typeof s.defaultAssignee === "string" ? s.defaultAssignee.trim().toLowerCase() : "",
    defaultReporter: typeof s.defaultReporter === "string" ? s.defaultReporter.trim().toLowerCase() : "",
    locationDepths: normalizeLocationDepths(s.locationDepths),
    locationOverrides: normalizeLocationOverrides(s.locationOverrides),
    tagPassthrough: s.tagPassthrough !== false,
    tagPrefix: typeof s.tagPrefix === "string" ? s.tagPrefix.trim() : "",
    derivedTags: normalizeDerivedTags(s.derivedTags),
    priorityRules: normalizePriorityRules(s.priorityRules),
    defaultPriority: priority,
    visibility: s.visibility === 0 ? 0 : 1,
    filters: s.filters == null ? null : normalizeFilters(s.filters),
  };
}

export async function loadMapping(env: Env, pairId: string): Promise<PairMapping> {
  const raw = await env.CONFIG.get(`${MAPPING_PREFIX}${pairId}`);
  if (!raw) return defaultMapping();
  try {
    return normalizeMapping(JSON.parse(raw));
  } catch {
    return defaultMapping();
  }
}

export async function saveMapping(env: Env, pairId: string, mapping: PairMapping): Promise<void> {
  await env.CONFIG.put(`${MAPPING_PREFIX}${pairId}`, JSON.stringify(normalizeMapping(mapping)));
}

export async function deleteMapping(env: Env, pairId: string): Promise<void> {
  await env.CONFIG.delete(`${MAPPING_PREFIX}${pairId}`);
}

/** The effective scope for a pair: its own override, else the global filters. */
export function effectiveFilters(cfg: AppConfig, mapping: PairMapping): SyncFilters {
  return mapping.filters ?? cfg.filters;
}

/** The visi type vocabulary the mapping UI offers, seeded from the API's documented list. */
export const KNOWN_VISI_TYPES = VISI_TYPES;
