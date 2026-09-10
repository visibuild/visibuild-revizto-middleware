/**
 * visibuild/resolve.ts – turn Visibuild's normalised records into the shapes
 * the sync actually needs: a location tree with nested paths, ProjectUser ->
 * email, ProjectCompany -> company name, and tag ids -> tag names.
 *
 * The lookups here change rarely, so they are cached hard: in memory per
 * isolate, then in KV (edge-cached) so they survive isolate recycling and we
 * almost never hit the rate-limited Visibuild endpoints during a sync run.
 */
import type { Env } from "../env";
import * as api from "./client";
import type { VisibuildCredentials } from "./client";
import type { DefectRound, Subtype, Tag, Visi } from "./types";

// ---------------------------------------------------------------------------
// Location tree
// ---------------------------------------------------------------------------

/** One location, placed in the project's tree. */
export interface LocationNode {
  id: string;
  name: string;
  /** 0 for the root, 1 for its children, and so on. */
  depth: number;
  /** Names from the root down to and including this location. */
  path: string[];
  parentId: string | null;
}

/**
 * Rebuild the location tree from the flat location list plus the closure table.
 *
 * The closure table holds one row per (ancestor, descendant, depth) pair, so a
 * location's depth is the largest depth at which it appears as a descendant,
 * and its ancestors – in order – are the rows leading to it. The root is the
 * location that never appears as a descendant at depth > 0.
 */
export function buildLocationTree(
  locations: { id: string; name: string }[],
  closures: { ancestorId: string; descendantId: string; depth: number }[],
): Map<string, LocationNode> {
  const names = new Map(locations.map((l) => [l.id, l.name]));
  // descendantId -> depth -> ancestorId. Depth 0 is the location itself.
  const ancestorsByDepth = new Map<string, Map<number, string>>();
  for (const c of closures) {
    if (!names.has(c.descendantId) || !names.has(c.ancestorId)) continue;
    let m = ancestorsByDepth.get(c.descendantId);
    if (!m) ancestorsByDepth.set(c.descendantId, (m = new Map()));
    m.set(c.depth, c.ancestorId);
  }

  const out = new Map<string, LocationNode>();
  for (const loc of locations) {
    const m = ancestorsByDepth.get(loc.id);
    // Depth here is the distance from the root: the deepest ancestor rung.
    const depth = m ? Math.max(0, ...m.keys()) : 0;
    const path: string[] = [];
    for (let d = depth; d >= 0; d--) {
      const ancestorId = d === 0 ? loc.id : m?.get(d);
      const name = ancestorId ? names.get(ancestorId) : undefined;
      if (name != null) path.push(name);
    }
    out.set(loc.id, {
      id: loc.id,
      name: loc.name,
      depth,
      path,
      parentId: m?.get(1) ?? null,
    });
  }
  return out;
}

/** "North Tower / Level 3 / Apartment 314" – the full path, root first. */
export function nestedName(node: LocationNode | undefined, separator = " / "): string {
  return node ? node.path.join(separator) : "";
}

// ---------------------------------------------------------------------------
// The per-project context a sync run needs
// ---------------------------------------------------------------------------

export interface ProjectContext {
  /** locationId -> node (depth, path). */
  locations: Map<string, LocationNode>;
  /** ProjectUser id -> the Visibuild user behind it. */
  projectUsers: Map<string, { email: string; name: string; companyName: string }>;
  /** ProjectCompany id -> company name. */
  projectCompanies: Map<string, string>;
  /** Tag id -> tag name. */
  tags: Map<string, string>;
  /** Subtype id -> subtype name. */
  subtypes: Map<string, Subtype>;
  /** ProjectMilestone id -> milestone name. */
  milestones: Map<string, string>;
  /** DefectRound id -> round name. */
  defectRounds: Map<string, DefectRound>;
}

const CACHE_TTL_SECONDS = 6 * 3600;
const KV_TTL_SECONDS = 7 * 24 * 3600;
const memo = new Map<string, { exp: number; ctx: ProjectContext }>();

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Drop every cached project context (used when credentials or config change). */
export function resetContextCache(): void {
  memo.clear();
}

/** JSON-safe form of a ProjectContext, for the KV round trip. */
interface SerialisedContext {
  locations: [string, LocationNode][];
  projectUsers: [string, { email: string; name: string; companyName: string }][];
  projectCompanies: [string, string][];
  tags: [string, string][];
  subtypes: [string, Subtype][];
  milestones: [string, string][];
  defectRounds: [string, DefectRound][];
}

function serialise(ctx: ProjectContext): SerialisedContext {
  return {
    locations: [...ctx.locations],
    projectUsers: [...ctx.projectUsers],
    projectCompanies: [...ctx.projectCompanies],
    tags: [...ctx.tags],
    subtypes: [...ctx.subtypes],
    milestones: [...ctx.milestones],
    defectRounds: [...ctx.defectRounds],
  };
}

function deserialise(s: SerialisedContext): ProjectContext {
  return {
    locations: new Map(s.locations),
    projectUsers: new Map(s.projectUsers),
    projectCompanies: new Map(s.projectCompanies),
    tags: new Map(s.tags),
    subtypes: new Map(s.subtypes),
    milestones: new Map(s.milestones),
    defectRounds: new Map(s.defectRounds),
  };
}

const CONTEXT_KV_PREFIX = "vbcache:context:";

/**
 * Load (and hard-cache) everything a sync run needs to resolve a project's
 * visis: locations, users, companies, tags, subtypes, milestones and rounds.
 * Pass `force` to bypass both caches after a config change.
 */
export async function loadProjectContext(
  env: Env,
  cfg: VisibuildCredentials,
  projectId: string,
  force = false,
): Promise<ProjectContext> {
  const cached = memo.get(projectId);
  if (!force && cached && cached.exp > now()) return cached.ctx;

  const kvKey = `${CONTEXT_KV_PREFIX}${projectId}`;
  if (!force) {
    try {
      const raw = await env.CONFIG.get(kvKey, { cacheTtl: 3600 });
      if (raw) {
        const ctx = deserialise(JSON.parse(raw) as SerialisedContext);
        memo.set(projectId, { exp: now() + CACHE_TTL_SECONDS, ctx });
        return ctx;
      }
    } catch {
      /* KV miss or parse failure – rebuild below */
    }
  }

  const [
    locations,
    closures,
    projectUsers,
    projectCompanies,
    companies,
    tags,
    subtypes,
    projectMilestones,
    allMilestones,
    defectRounds,
  ] = await Promise.all([
    api.listLocations(cfg, projectId),
    api.listLocationClosures(cfg, projectId),
    api.listProjectUsers(cfg, projectId),
    api.listProjectCompanies(cfg, projectId),
    api.listCompanies(cfg),
    api.listTags(cfg).catch(() => [] as Tag[]),
    api.listSubtypes(cfg, projectId).catch(() => [] as Subtype[]),
    api.listProjectMilestones(cfg, projectId).catch(() => []),
    api.listMilestones(cfg).catch(() => []),
    api.listDefectRounds(cfg, projectId).catch(() => [] as DefectRound[]),
  ]);

  const companyNames = new Map(companies.map((c) => [c.id, c.name]));

  // ProjectCompany id -> company name.
  const projectCompanyNames = new Map<string, string>();
  for (const pc of projectCompanies) {
    const name = pc.companyId ? companyNames.get(pc.companyId) ?? "" : "";
    if (name) projectCompanyNames.set(pc.id, name);
  }

  // ProjectUser id -> user. Users live under their company, so fetch the user
  // list once per company referenced by this project's members.
  const companyIds = [
    ...new Set(
      projectUsers
        .map((pu) => (pu.projectCompanyId ? projectCompanies.find((pc) => pc.id === pu.projectCompanyId) : null))
        .map((pc) => pc?.companyId)
        .filter(Boolean) as string[],
    ),
  ];
  const userLists = await Promise.all(
    companyIds.map((cid) => api.listCompanyUsers(cfg, cid).catch(() => [])),
  );
  const usersById = new Map<string, { email: string; name: string }>();
  for (const list of userLists) {
    for (const u of list) usersById.set(u.id, { email: u.email, name: u.name });
  }

  const projectUserMap = new Map<string, { email: string; name: string; companyName: string }>();
  for (const pu of projectUsers) {
    const u = pu.userId ? usersById.get(pu.userId) : undefined;
    projectUserMap.set(pu.id, {
      email: u?.email ?? "",
      name: u?.name ?? "",
      companyName: pu.projectCompanyId ? projectCompanyNames.get(pu.projectCompanyId) ?? "" : "",
    });
  }

  // ProjectMilestone id -> milestone name.
  const milestoneNames = new Map(allMilestones.map((m) => [m.id, m.name]));
  const milestones = new Map<string, string>();
  for (const pm of projectMilestones) {
    const name = pm.milestoneId ? milestoneNames.get(pm.milestoneId) ?? "" : "";
    if (name) milestones.set(pm.id, name);
  }

  const ctx: ProjectContext = {
    locations: buildLocationTree(locations, closures),
    projectUsers: projectUserMap,
    projectCompanies: projectCompanyNames,
    tags: new Map(tags.map((t) => [t.id, t.name])),
    subtypes: new Map(subtypes.map((t) => [t.id, t])),
    milestones,
    defectRounds: new Map(defectRounds.map((r) => [r.id, r])),
  };

  memo.set(projectId, { exp: now() + CACHE_TTL_SECONDS, ctx });
  try {
    await env.CONFIG.put(kvKey, JSON.stringify(serialise(ctx)), { expirationTtl: KV_TTL_SECONDS });
  } catch {
    /* best-effort write; the in-memory cache still serves this isolate */
  }
  return ctx;
}

/** The deep link back to a visi in the Visibuild web app. */
export function visiUrl(apiUrl: string, visi: Visi): string {
  const base = api.appUrlFromApiUrl(apiUrl);
  if (!visi.projectId) return `${base}/visis/${encodeURIComponent(visi.id)}`;
  return `${base}/projects/${encodeURIComponent(visi.projectId)}/visis/${encodeURIComponent(visi.id)}`;
}
