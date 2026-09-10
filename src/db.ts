/**
 * db.ts – the D1 sync state.
 *
 * Four tables (see schema.sql): the project pairs being synced, the visi ->
 * Revizto issue links with their shadow of last-pushed values, and a run log
 * split into runs and per-visi events.
 *
 * The shadow is what makes an update cheap: Revizto edits are diffs that need
 * the field's *current* value, and when nobody has touched the issue in Revizto
 * the value we last wrote is that current value.
 */
import type { Env } from "./env";
import type { ManagedFields } from "./revizto/types";

export interface ProjectPair {
  id: string;
  visibuildProjectId: string;
  visibuildProjectName: string;
  reviztoRegion: string;
  reviztoLicenseUuid: string;
  reviztoProjectUuid: string;
  reviztoProjectId: number;
  reviztoProjectName: string;
  enabled: boolean;
  /** Highest visi updatedAt successfully processed; null means never synced. */
  visiCursor: string | null;
  /** The `synchronized` watermark from the last Revizto issue sweep. */
  reviztoCursor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueLink {
  pairId: string;
  visiId: string;
  issueUuid: string;
  visiUpdatedAt: string | null;
  shadow: Partial<ManagedFields>;
  syncedAttachmentIds: string[];
  syncedRequirementIds: string[];
  statusHistoryCursor: string | null;
  state: "ok" | "error" | "pending";
  lastError: string | null;
}

export type SyncTrigger = "cron" | "manual";
export type SyncStatus = "running" | "ok" | "partial" | "failed";
export type SyncAction = "create" | "update" | "skip" | "conflict" | "error";

export interface SyncRun {
  id: string;
  trigger: SyncTrigger;
  status: SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  failed: number;
  message: string | null;
}

export interface SyncEvent {
  id: number;
  runId: string;
  pairId: string | null;
  visiId: string | null;
  visiAlias: string | null;
  action: SyncAction;
  detail: unknown;
  createdAt: string;
}

const nowIso = () => new Date().toISOString();

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Project pairs
// ---------------------------------------------------------------------------

function rowToPair(r: any): ProjectPair {
  return {
    id: String(r.id),
    visibuildProjectId: String(r.visibuild_project_id),
    visibuildProjectName: String(r.visibuild_project_name ?? ""),
    reviztoRegion: String(r.revizto_region),
    reviztoLicenseUuid: String(r.revizto_license_uuid),
    reviztoProjectUuid: String(r.revizto_project_uuid),
    reviztoProjectId: Number(r.revizto_project_id),
    reviztoProjectName: String(r.revizto_project_name ?? ""),
    enabled: Number(r.enabled) === 1,
    visiCursor: r.visi_cursor ?? null,
    reviztoCursor: r.revizto_cursor ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function listPairs(env: Env): Promise<ProjectPair[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM project_pairs ORDER BY visibuild_project_name, revizto_project_name",
  ).all();
  return (results ?? []).map(rowToPair);
}

export async function listEnabledPairs(env: Env): Promise<ProjectPair[]> {
  return (await listPairs(env)).filter((p) => p.enabled);
}

export async function getPair(env: Env, id: string): Promise<ProjectPair | null> {
  const row = await env.DB.prepare("SELECT * FROM project_pairs WHERE id = ?").bind(id).first();
  return row ? rowToPair(row) : null;
}

export interface NewPair {
  visibuildProjectId: string;
  visibuildProjectName: string;
  reviztoRegion: string;
  reviztoLicenseUuid: string;
  reviztoProjectUuid: string;
  reviztoProjectId: number;
  reviztoProjectName: string;
}

export async function createPair(env: Env, input: NewPair): Promise<ProjectPair> {
  const id = crypto.randomUUID();
  const ts = nowIso();
  await env.DB.prepare(
    `INSERT INTO project_pairs
       (id, visibuild_project_id, visibuild_project_name, revizto_region, revizto_license_uuid,
        revizto_project_uuid, revizto_project_id, revizto_project_name, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      id,
      input.visibuildProjectId,
      input.visibuildProjectName,
      input.reviztoRegion,
      input.reviztoLicenseUuid,
      input.reviztoProjectUuid,
      input.reviztoProjectId,
      input.reviztoProjectName,
      ts,
      ts,
    )
    .run();
  return (await getPair(env, id))!;
}

export async function setPairEnabled(env: Env, id: string, enabled: boolean): Promise<void> {
  await env.DB.prepare("UPDATE project_pairs SET enabled = ?, updated_at = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, nowIso(), id)
    .run();
}

export async function setPairCursors(
  env: Env,
  id: string,
  cursors: { visiCursor?: string | null; reviztoCursor?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (cursors.visiCursor !== undefined) {
    sets.push("visi_cursor = ?");
    binds.push(cursors.visiCursor);
  }
  if (cursors.reviztoCursor !== undefined) {
    sets.push("revizto_cursor = ?");
    binds.push(cursors.reviztoCursor);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  binds.push(nowIso(), id);
  await env.DB.prepare(`UPDATE project_pairs SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

/** Forget a pair's watermarks so the next run re-reads everything. */
export async function resetPairCursors(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE project_pairs SET visi_cursor = NULL, revizto_cursor = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(), id)
    .run();
}

export async function deletePair(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM issue_links WHERE pair_id = ?").bind(id),
    env.DB.prepare("DELETE FROM project_pairs WHERE id = ?").bind(id),
  ]);
}

// ---------------------------------------------------------------------------
// Issue links
// ---------------------------------------------------------------------------

function rowToLink(r: any): IssueLink {
  return {
    pairId: String(r.pair_id),
    visiId: String(r.visi_id),
    issueUuid: String(r.issue_uuid),
    visiUpdatedAt: r.visi_updated_at ?? null,
    shadow: parseJson<Partial<ManagedFields>>(r.shadow, {}),
    syncedAttachmentIds: parseJson<string[]>(r.synced_attachment_ids, []),
    syncedRequirementIds: parseJson<string[]>(r.synced_requirement_ids, []),
    statusHistoryCursor: r.status_history_cursor ?? null,
    state: (r.state as IssueLink["state"]) ?? "ok",
    lastError: r.last_error ?? null,
  };
}

/**
 * Every link for a pair, keyed by visi id. A project's link set is small enough
 * (one row per synced visi) to hold in memory for the length of a run, and one
 * query beats a lookup per visi.
 */
export async function loadLinks(env: Env, pairId: string): Promise<Map<string, IssueLink>> {
  const { results } = await env.DB.prepare("SELECT * FROM issue_links WHERE pair_id = ?").bind(pairId).all();
  return new Map((results ?? []).map((r) => [String((r as any).visi_id), rowToLink(r)]));
}

export async function countLinks(env: Env, pairId: string): Promise<{ total: number; errored: number }> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) AS errored FROM issue_links WHERE pair_id = ?",
  )
    .bind(pairId)
    .first();
  return { total: Number((row as any)?.total ?? 0), errored: Number((row as any)?.errored ?? 0) };
}

/**
 * Reserve the issue UUID we are about to create, before calling Revizto.
 *
 * Writing this first means a create that times out mid-flight still leaves a
 * record of the UUID we used, so the next run can recognise the issue rather
 * than creating a duplicate.
 */
export async function reserveLink(
  env: Env,
  pairId: string,
  visiId: string,
  issueUuid: string,
): Promise<void> {
  const ts = nowIso();
  await env.DB.prepare(
    `INSERT INTO issue_links (pair_id, visi_id, issue_uuid, state, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (pair_id, visi_id) DO UPDATE SET issue_uuid = excluded.issue_uuid, updated_at = excluded.updated_at`,
  )
    .bind(pairId, visiId, issueUuid, ts, ts)
    .run();
}

export async function saveLink(
  env: Env,
  link: Omit<IssueLink, "lastError"> & { lastError?: string | null },
): Promise<void> {
  const ts = nowIso();
  await env.DB.prepare(
    `INSERT INTO issue_links
       (pair_id, visi_id, issue_uuid, visi_updated_at, shadow, synced_attachment_ids,
        synced_requirement_ids, status_history_cursor, state, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (pair_id, visi_id) DO UPDATE SET
       issue_uuid = excluded.issue_uuid,
       visi_updated_at = excluded.visi_updated_at,
       shadow = excluded.shadow,
       synced_attachment_ids = excluded.synced_attachment_ids,
       synced_requirement_ids = excluded.synced_requirement_ids,
       status_history_cursor = excluded.status_history_cursor,
       state = excluded.state,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  )
    .bind(
      link.pairId,
      link.visiId,
      link.issueUuid,
      link.visiUpdatedAt,
      JSON.stringify(link.shadow ?? {}),
      JSON.stringify(link.syncedAttachmentIds ?? []),
      JSON.stringify(link.syncedRequirementIds ?? []),
      link.statusHistoryCursor,
      link.state,
      link.lastError ?? null,
      ts,
      ts,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

function rowToRun(r: any): SyncRun {
  return {
    id: String(r.id),
    trigger: r.trigger as SyncTrigger,
    status: r.status as SyncStatus,
    startedAt: String(r.started_at),
    finishedAt: r.finished_at ?? null,
    created: Number(r.created ?? 0),
    updated: Number(r.updated ?? 0),
    skipped: Number(r.skipped ?? 0),
    conflicts: Number(r.conflicts ?? 0),
    failed: Number(r.failed ?? 0),
    message: r.message ?? null,
  };
}

export async function startRun(env: Env, trigger: SyncTrigger): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO sync_runs (id, trigger, status, started_at) VALUES (?, ?, 'running', ?)",
  )
    .bind(id, trigger, nowIso())
    .run();
  return id;
}

export async function finishRun(
  env: Env,
  id: string,
  totals: { status: SyncStatus; created: number; updated: number; skipped: number; conflicts: number; failed: number; message?: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sync_runs SET status = ?, finished_at = ?, created = ?, updated = ?,
       skipped = ?, conflicts = ?, failed = ?, message = ? WHERE id = ?`,
  )
    .bind(
      totals.status,
      nowIso(),
      totals.created,
      totals.updated,
      totals.skipped,
      totals.conflicts,
      totals.failed,
      totals.message ?? null,
      id,
    )
    .run();
}

export async function listRuns(env: Env, limit = 25): Promise<SyncRun[]> {
  const { results } = await env.DB.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?")
    .bind(limit)
    .all();
  return (results ?? []).map(rowToRun);
}

export async function getRun(env: Env, id: string): Promise<SyncRun | null> {
  const row = await env.DB.prepare("SELECT * FROM sync_runs WHERE id = ?").bind(id).first();
  return row ? rowToRun(row) : null;
}

export async function latestRun(env: Env): Promise<SyncRun | null> {
  const row = await env.DB.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1").first();
  return row ? rowToRun(row) : null;
}

const EVENT_BATCH_SIZE = 100;

/**
 * Append events in one batch. Callers buffer a run's events and flush here so a
 * busy run costs a handful of D1 round trips rather than one per visi.
 */
export async function addEvents(
  env: Env,
  runId: string,
  events: { pairId?: string; visiId?: string; visiAlias?: string | null; action: SyncAction; detail?: unknown }[],
): Promise<void> {
  if (events.length === 0) return;
  const ts = nowIso();
  const stmt = env.DB.prepare(
    "INSERT INTO sync_events (run_id, pair_id, visi_id, visi_alias, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const bind = (e: (typeof events)[number]) =>
    stmt.bind(
      runId,
      e.pairId ?? null,
      e.visiId ?? null,
      e.visiAlias ?? null,
      e.action,
      e.detail === undefined ? null : JSON.stringify(e.detail),
      ts,
    );
  // Chunked, so a busy run does not hand D1 one enormous batch.
  for (let i = 0; i < events.length; i += EVENT_BATCH_SIZE) {
    await env.DB.batch(events.slice(i, i + EVENT_BATCH_SIZE).map(bind));
  }
}

export async function listEvents(env: Env, runId: string, limit = 500): Promise<SyncEvent[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM sync_events WHERE run_id = ? ORDER BY id LIMIT ?",
  )
    .bind(runId, limit)
    .all();
  return (results ?? []).map((r: any) => ({
    id: Number(r.id),
    runId: String(r.run_id),
    pairId: r.pair_id ?? null,
    visiId: r.visi_id ?? null,
    visiAlias: r.visi_alias ?? null,
    action: r.action as SyncAction,
    detail: parseJson<unknown>(r.detail, null),
    createdAt: String(r.created_at),
  }));
}

/** Trim the run log. Called after each run so the table cannot grow unbounded. */
export async function pruneRuns(env: Env, keep = 200): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM sync_events WHERE run_id IN
         (SELECT id FROM sync_runs ORDER BY started_at DESC LIMIT -1 OFFSET ?)`,
    ).bind(keep),
    env.DB.prepare(
      `DELETE FROM sync_runs WHERE id IN
         (SELECT id FROM sync_runs ORDER BY started_at DESC LIMIT -1 OFFSET ?)`,
    ).bind(keep),
  ]);
}

/** True when the schema has been applied. The dashboard uses this to nag. */
export async function schemaReady(env: Env): Promise<boolean> {
  try {
    await env.DB.prepare("SELECT 1 FROM project_pairs LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}
