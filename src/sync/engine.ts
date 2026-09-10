/**
 * sync/engine.ts – the sync run.
 *
 * One direction only: Visibuild is the source of truth, Revizto is the mirror.
 * Per project pair the run does four things in order –
 *
 *   1. sweep Revizto for issues changed since last time, so we know the
 *      *current* value of any field before we try to diff it;
 *   2. pull the visis changed since last time, plus the batch's tags,
 *      checklist answers, status history and attachments;
 *   3. create or update the matching Revizto issue for each visi;
 *   4. advance the watermarks and write the run log.
 *
 * Everything is bounded: a run processes at most `limits.visisPerRun` visis per
 * pair and uploads at most `limits.attachmentsPerRun` files, so a single Worker
 * invocation always finishes. The watermark only advances over visis that
 * actually succeeded, so hitting a cap or failing halfway simply means the next
 * run resumes from the same place.
 */
import {
  effectiveFilters,
  hasReviztoCredentials,
  hasVisibuildCredentials,
  loadConfig,
  loadMapping,
  reviztoConnection,
  visibuildCredentials,
  type AppConfig,
  type ContentOptions,
  type PairMapping,
  type SyncFilters,
} from "../config";
import * as db from "../db";
import type { Env } from "../env";
import * as revizto from "../revizto/client";
import { ReviztoAuthError } from "../revizto/oauth";
import type { ManagedFields, ReviztoIssue } from "../revizto/types";
import * as vb from "../visibuild/client";
import { loadProjectContext, visiUrl } from "../visibuild/resolve";
import type { ProjectAttachment, Visi, VisiRequirement, VisiStatusChange } from "../visibuild/types";
import { AttachmentSkipped, fetchAttachment } from "./attachments";
import {
  buildDiff,
  detectConflicts,
  mapVisi,
  renderDescription,
  renderRequirements,
  renderStatusChanges,
  type MappingContext,
} from "./mapping";

export interface RunOptions {
  trigger: db.SyncTrigger;
  /** Restrict the run to a single pair – the per-pair "Sync now" button. */
  pairId?: string;
}

export interface RunSummary {
  runId: string;
  status: db.SyncStatus;
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  failed: number;
  message: string | null;
}

type EventInput = Parameters<typeof db.addEvents>[2][number];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Revizto issue UUIDs are generated client-side, so we reuse the visi's own id
 * when it is a valid v4 – that makes the mapping obvious to anyone reading both
 * systems. Ids that don't qualify get a fresh UUID, recorded in `issue_links`.
 */
export function issueUuidForVisi(visiId: string): string {
  return UUID_V4.test(visiId) ? visiId.toLowerCase() : crypto.randomUUID();
}

/**
 * Whether a visi is eligible to be *created* in Revizto.
 *
 * Note the asymmetry: filters gate creation only. Once a visi has been mirrored
 * it keeps syncing even if it later falls outside the filter – otherwise a visi
 * that moved to an excluded status would freeze in Revizto showing a state that
 * is no longer true, which is worse than an extra row.
 */
export function isEligible(visi: Visi, filters: SyncFilters): { ok: boolean; reason?: string } {
  if (visi.archived && !filters.includeArchived) return { ok: false, reason: "Visi is archived." };
  if (filters.rootOnly && !visi.isRoot) return { ok: false, reason: "Not a root visi." };
  if (filters.categories.length && !filters.categories.includes(visi.category ?? "")) {
    return { ok: false, reason: `Category "${visi.category ?? "none"}" is not in the sync scope.` };
  }
  if (filters.types.length && !filters.types.includes(visi.type ?? "")) {
    return { ok: false, reason: `Type "${visi.type ?? "none"}" is not in the sync scope.` };
  }
  if (filters.statuses.length && !filters.statuses.includes(visi.status)) {
    return { ok: false, reason: `Status "${visi.status}" is not in the sync scope.` };
  }
  return { ok: true };
}

/** Group rows by a key, for indexing the per-batch lookups. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-pair state carried through one sync
// ---------------------------------------------------------------------------

interface PairTotals {
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  failed: number;
  /** True when the run stopped at a cap rather than reaching the end. */
  truncated: boolean;
}

interface PairBatch {
  visis: Visi[];
  /** True when more visis were waiting than the per-run cap allows. */
  moreWaiting: boolean;
  requirementsByVisi: Map<string, VisiRequirement[]>;
  statusChangesByVisi: Map<string, VisiStatusChange[]>;
  attachmentsById: Map<string, ProjectAttachment>;
  liveIssues: Map<string, ReviztoIssue>;
  reviztoWatermark: string | null;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runSync(env: Env, opts: RunOptions): Promise<RunSummary> {
  const cfg = await loadConfig(env);
  const runId = await db.startRun(env, opts.trigger);
  const events: EventInput[] = [];
  const totals: PairTotals = { created: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0, truncated: false };
  const notes: string[] = [];

  const finish = async (status: db.SyncStatus, message?: string): Promise<RunSummary> => {
    await db.addEvents(env, runId, events);
    await db.finishRun(env, runId, { status, ...totals, message });
    await db.pruneRuns(env).catch(() => {
      /* pruning is housekeeping; never fail a run over it */
    });
    return { runId, status, ...totals, message: message ?? null };
  };

  if (!hasVisibuildCredentials(cfg)) {
    return finish("failed", "Visibuild is not connected. Add the API credentials in Settings.");
  }
  if (!hasReviztoCredentials(cfg)) {
    return finish("failed", "Revizto app credentials are missing. Add them in Settings.");
  }

  let pairs: db.ProjectPair[];
  try {
    if (opts.pairId) {
      const one = await db.getPair(env, opts.pairId);
      pairs = one ? [one] : [];
    } else {
      pairs = await db.listEnabledPairs(env);
    }
  } catch (e) {
    return finish("failed", `Couldn't read the project pairs: ${(e as Error).message}`);
  }

  if (pairs.length === 0) {
    return finish("ok", opts.pairId ? "That project pair no longer exists." : "No enabled project pairs to sync.");
  }

  for (const pair of pairs) {
    try {
      const note = await syncPair(env, cfg, pair, totals, events);
      if (note) notes.push(`${pair.visibuildProjectName || pair.visibuildProjectId}: ${note}`);
    } catch (e) {
      // A lapsed authorisation or a rate limit will hit every remaining pair
      // the same way, so stop rather than grinding through them.
      if (e instanceof ReviztoAuthError || vb.isRateLimited(e)) {
        const text = vb.isRateLimited(e)
          ? "Visibuild has temporarily rate-limited this app. The next run will pick up where this one stopped."
          : (e as Error).message;
        totals.failed++;
        events.push({ pairId: pair.id, action: "error", detail: { message: text, fatal: true } });
        return finish("failed", text);
      }
      totals.failed++;
      events.push({ pairId: pair.id, action: "error", detail: { message: (e as Error).message } });
      notes.push(`${pair.visibuildProjectName || pair.visibuildProjectId}: ${(e as Error).message}`);
    }
  }

  const status: db.SyncStatus = totals.failed > 0 ? "partial" : totals.truncated ? "partial" : "ok";
  const message =
    notes.length > 0
      ? notes.join(" · ")
      : totals.truncated
        ? "Stopped at the per-run cap; the next run will continue from here."
        : undefined;
  return finish(status, message);
}

// ---------------------------------------------------------------------------
// One project pair
// ---------------------------------------------------------------------------

async function syncPair(
  env: Env,
  cfg: AppConfig,
  pair: db.ProjectPair,
  totals: PairTotals,
  events: EventInput[],
): Promise<string | null> {
  const mapping = await loadMapping(env, pair.id);
  const filters = effectiveFilters(cfg, mapping);
  const vbCreds = visibuildCredentials(cfg);
  const conn = { ...reviztoConnection(cfg), region: pair.reviztoRegion };

  const [projectContext, links] = await Promise.all([
    loadProjectContext(env, vbCreds, pair.visibuildProjectId),
    db.loadLinks(env, pair.id),
  ]);

  const batch = await loadBatch(env, cfg, pair, mapping, conn);
  if (batch.visis.length === 0) {
    // Still bank the Revizto watermark: the sweep succeeded even if no visi moved.
    await db.setPairCursors(env, pair.id, { reviztoCursor: batch.reviztoWatermark ?? pair.reviztoCursor });
    return null;
  }

  const mctx: MappingContext = {
    locations: projectContext.locations,
    projectUsers: projectContext.projectUsers,
    projectCompanies: projectContext.projectCompanies,
    subtypeNames: new Map([...projectContext.subtypes].map(([id, s]) => [id, s.name])),
    milestoneNames: projectContext.milestones,
    defectRoundNames: new Map([...projectContext.defectRounds].map(([id, r]) => [id, r.roundName])),
    visiTagNames: await loadVisiTagNames(cfg, pair, mapping, projectContext.tags),
  };

  let attachmentBudget = cfg.limits.attachmentsPerRun;
  let truncated = false;
  // Only advance the watermark over an unbroken prefix of successes, so a
  // failure part-way is retried rather than skipped.
  let cursor: string | null = pair.visiCursor;
  let cursorOpen = true;

  for (const visi of batch.visis) {
    const link = links.get(visi.id) ?? null;

    // A visi we already failed on at this exact version is not retried
    // forever – log why and let the watermark move past it.
    if (link?.state === "error" && link.visiUpdatedAt === visi.updatedAt) {
      totals.skipped++;
      events.push({
        pairId: pair.id,
        visiId: visi.id,
        visiAlias: visi.alias,
        action: "skip",
        detail: { reason: "Previously failed at this version; not retried.", error: link.lastError },
      });
      if (cursorOpen) cursor = visi.updatedAt ?? cursor;
      continue;
    }

    try {
      const outcome = await syncVisi({
        env,
        cfg,
        pair,
        mapping,
        filters,
        conn,
        mctx,
        batch,
        visi,
        link,
        attachmentBudget,
        totals,
        events,
      });
      attachmentBudget -= outcome.attachmentsUsed;

      if (outcome.deferred > 0) {
        // This visi still has attachments to upload. Leaving the watermark
        // behind it is what brings it back next run – advancing past it would
        // strand those files for good, since the visi would never be re-read.
        truncated = true;
        cursorOpen = false;
        break;
      }
      if (cursorOpen) cursor = visi.updatedAt ?? cursor;
    } catch (e) {
      if (e instanceof ReviztoAuthError || vb.isRateLimited(e)) throw e;
      totals.failed++;
      cursorOpen = false;
      events.push({
        pairId: pair.id,
        visiId: visi.id,
        visiAlias: visi.alias,
        action: "error",
        detail: { message: (e as Error).message },
      });
      await db
        .saveLink(env, {
          pairId: pair.id,
          visiId: visi.id,
          issueUuid: link?.issueUuid ?? issueUuidForVisi(visi.id),
          visiUpdatedAt: visi.updatedAt,
          shadow: link?.shadow ?? {},
          syncedAttachmentIds: link?.syncedAttachmentIds ?? [],
          syncedRequirementIds: link?.syncedRequirementIds ?? [],
          statusHistoryCursor: link?.statusHistoryCursor ?? null,
          state: "error",
          lastError: (e as Error).message,
        })
        .catch(() => {
          /* the event log already records the failure */
        });
    }
  }

  if (batch.moreWaiting) truncated = true;
  if (truncated) totals.truncated = true;

  await db.setPairCursors(env, pair.id, {
    visiCursor: cursor,
    reviztoCursor: batch.reviztoWatermark ?? pair.reviztoCursor,
  });

  return truncated ? "stopped at the per-run cap" : null;
}

// ---------------------------------------------------------------------------
// Loading a batch
// ---------------------------------------------------------------------------

async function loadBatch(
  env: Env,
  cfg: AppConfig,
  pair: db.ProjectPair,
  mapping: PairMapping,
  conn: revizto.ReviztoConnection,
): Promise<PairBatch> {
  const vbCreds = visibuildCredentials(cfg);
  const since = pair.visiCursor;

  // Revizto first: this is what tells us the true current value of a field, so
  // a diff we build has the right `old` even when someone edited by hand.
  const sweep = await revizto.sweepIssues(env, conn, pair.reviztoProjectUuid, pair.reviztoCursor);

  const all = await vb.listVisis(vbCreds, pair.visibuildProjectId, { updatedAfter: since ?? undefined });
  // Oldest first, so the watermark advances monotonically as we go.
  all.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
  const visis = all.slice(0, cfg.limits.visisPerRun);
  const moreWaiting = all.length > visis.length;

  // The supporting rows all carry their own updatedAt, so the same watermark
  // covers both a brand-new visi and a change to an existing one's answers.
  const wantRequirements = cfg.content.requirements;
  const wantHistory = cfg.content.statusHistory;
  const wantAttachments = cfg.content.attachments;

  const [requirements, statusChanges, attachments] = await Promise.all([
    wantRequirements
      ? vb.listVisiRequirements(vbCreds, pair.visibuildProjectId, { updatedAfter: since ?? undefined }).catch(() => [])
      : Promise.resolve([] as VisiRequirement[]),
    wantHistory
      ? vb.listVisiStatusChanges(vbCreds, pair.visibuildProjectId, { updatedAfter: since ?? undefined }).catch(() => [])
      : Promise.resolve([] as VisiStatusChange[]),
    wantAttachments
      ? vb.listProjectAttachments(vbCreds, pair.visibuildProjectId, { updatedAfter: since ?? undefined }).catch(() => [])
      : Promise.resolve([] as ProjectAttachment[]),
  ]);

  return {
    visis,
    moreWaiting,
    requirementsByVisi: groupBy(requirements, (r) => r.visiId),
    statusChangesByVisi: groupBy(statusChanges, (c) => c.visiId),
    attachmentsById: new Map(attachments.map((a) => [a.id, a])),
    liveIssues: new Map(sweep.issues.map((i) => [i.uuid.toLowerCase(), i])),
    reviztoWatermark: sweep.synchronized,
  };
}

/**
 * Visi tags for the whole project, keyed by visi.
 *
 * There is no per-visi tag endpoint and a removed tag leaves no `updatedAfter`
 * trace, so getting removals right means reading the whole set. It is only
 * fetched when tag passthrough is actually switched on.
 */
async function loadVisiTagNames(
  cfg: AppConfig,
  pair: db.ProjectPair,
  mapping: PairMapping,
  tagNames: Map<string, string>,
): Promise<Map<string, string[]>> {
  if (!mapping.tagPassthrough) return new Map();
  const rows = await vb
    .listVisiTags(visibuildCredentials(cfg), pair.visibuildProjectId)
    .catch(() => []);
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const name = tagNames.get(row.tagId);
    if (!name) continue;
    const list = out.get(row.visiId);
    if (list) list.push(name);
    else out.set(row.visiId, [name]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// One visi
// ---------------------------------------------------------------------------

interface VisiSyncArgs {
  env: Env;
  cfg: AppConfig;
  pair: db.ProjectPair;
  mapping: PairMapping;
  filters: SyncFilters;
  conn: revizto.ReviztoConnection;
  mctx: MappingContext;
  batch: PairBatch;
  visi: Visi;
  link: db.IssueLink | null;
  attachmentBudget: number;
  totals: PairTotals;
  events: EventInput[];
}

/** How one visi's work landed, from the caller's point of view. */
interface VisiOutcome {
  /** Attachments uploaded, to draw down the run's budget. */
  attachmentsUsed: number;
  /** Attachments left behind because the budget ran out mid-visi. */
  deferred: number;
}

async function syncVisi(args: VisiSyncArgs): Promise<VisiOutcome> {
  const { pair, mapping, filters, mctx, batch, visi, totals, events } = args;
  let link = args.link;

  if (!link) {
    const eligible = isEligible(visi, filters);
    if (!eligible.ok) {
      totals.skipped++;
      events.push({
        pairId: pair.id,
        visiId: visi.id,
        visiAlias: visi.alias,
        action: "skip",
        detail: { reason: eligible.reason },
      });
      return { attachmentsUsed: 0, deferred: 0 };
    }
    // A create that timed out mid-flight leaves a reserved uuid behind; if the
    // sweep shows the issue, adopt it instead of creating a duplicate.
    const candidate = issueUuidForVisi(visi.id);
    if (batch.liveIssues.has(candidate.toLowerCase())) {
      link = {
        pairId: pair.id,
        visiId: visi.id,
        issueUuid: candidate,
        visiUpdatedAt: null,
        shadow: {},
        syncedAttachmentIds: [],
        syncedRequirementIds: [],
        statusHistoryCursor: null,
        state: "ok",
        lastError: null,
      };
    }
  }

  const mapped = mapVisi(visi, mapping, mctx);
  return link
    ? updateIssue({ ...args, link }, mapped)
    : createIssue(args, mapped);
}

type Mapped = ReturnType<typeof mapVisi>;

async function createIssue(args: VisiSyncArgs, mapped: Mapped): Promise<VisiOutcome> {
  const { env, cfg, pair, conn, mctx, batch, visi, totals, events } = args;
  const issueUuid = issueUuidForVisi(visi.id);

  // Record the uuid before the call: if the create succeeds but the response
  // never reaches us, the next run recognises the issue rather than duplicating it.
  await db.reserveLink(env, pair.id, visi.id, issueUuid);

  await revizto.createIssue(env, conn, {
    uuid: issueUuid,
    projectId: pair.reviztoProjectId,
    fields: mapped.fields,
    created: mapped.created || undefined,
    location: mapped.location,
  });

  const requirements = batch.requirementsByVisi.get(visi.id) ?? [];
  const statusChanges = batch.statusChangesByVisi.get(visi.id) ?? [];

  const { attachmentsUsed, deferred, attachmentNotes, syncedAttachmentIds } = await postContent({
    env,
    cfg,
    pair,
    conn,
    mctx,
    visi,
    issueUuid,
    reporter: mapped.fields.reporter,
    description: cfg.content.description
      ? renderDescription(visi, { link: visiUrl(cfg.visibuildApiUrl, visi), includeLink: cfg.content.backLink })
      : "",
    requirements,
    statusChanges,
    attachments: attachmentsFor(visi, batch, cfg.content),
    budget: args.attachmentBudget,
    alreadySynced: [],
  });

  await db.saveLink(env, {
    pairId: pair.id,
    visiId: visi.id,
    issueUuid,
    visiUpdatedAt: visi.updatedAt,
    shadow: mapped.fields,
    syncedAttachmentIds,
    syncedRequirementIds: requirements.map((r) => r.id),
    statusHistoryCursor: latestTimestamp(statusChanges),
    state: "ok",
    lastError: null,
  });

  totals.created++;
  events.push({
    pairId: pair.id,
    visiId: visi.id,
    visiAlias: visi.alias,
    action: "create",
    detail: {
      issueUuid,
      title: mapped.fields.title,
      warnings: mapped.warnings,
      attachments: attachmentNotes,
    },
  });
  return { attachmentsUsed, deferred };
}

async function updateIssue(
  args: VisiSyncArgs & { link: db.IssueLink },
  mapped: Mapped,
): Promise<VisiOutcome> {
  const { env, cfg, pair, conn, mctx, batch, visi, link, totals, events } = args;

  const live = batch.liveIssues.get(link.issueUuid.toLowerCase());
  // Prefer what Revizto actually holds; fall back to the shadow of what we last
  // wrote, which is correct whenever nobody has touched the issue by hand.
  const current: Partial<ManagedFields> = live ? { ...link.shadow, ...live.fields } : link.shadow;
  const conflicts = live ? detectConflicts(link.shadow, live.fields) : [];

  const { diff, changed } = buildDiff(current, mapped.fields);

  const requirements = (batch.requirementsByVisi.get(visi.id) ?? []).filter(
    (r) => !link.syncedRequirementIds.includes(r.id),
  );
  const statusChanges = (batch.statusChangesByVisi.get(visi.id) ?? []).filter(
    (c) => !link.statusHistoryCursor || (c.timestamp ?? "") > link.statusHistoryCursor,
  );
  const newAttachments = attachmentsFor(visi, batch, cfg.content).filter(
    (a) => !link.syncedAttachmentIds.includes(a.id),
  );

  const nothingToDo =
    changed.length === 0 && requirements.length === 0 && statusChanges.length === 0 && newAttachments.length === 0;

  if (nothingToDo) {
    totals.skipped++;
    events.push({
      pairId: pair.id,
      visiId: visi.id,
      visiAlias: visi.alias,
      action: "skip",
      detail: { reason: "Already up to date in Revizto." },
    });
    // Bank the visi version so the "previously failed" guard stays accurate.
    await db.saveLink(env, { ...link, visiUpdatedAt: visi.updatedAt, state: "ok", lastError: null });
    return { attachmentsUsed: 0, deferred: 0 };
  }

  if (changed.length > 0) {
    await revizto.addComments(env, conn, {
      projectUuid: pair.reviztoProjectUuid,
      projectId: pair.reviztoProjectId,
      issueUuid: link.issueUuid,
      comments: [
        {
          kind: "diff",
          uuid: crypto.randomUUID(),
          diff,
          reporter: mapped.fields.reporter || undefined,
        },
      ],
    });
  }

  const { attachmentsUsed, deferred, attachmentNotes, syncedAttachmentIds } = await postContent({
    env,
    cfg,
    pair,
    conn,
    mctx,
    visi,
    issueUuid: link.issueUuid,
    reporter: mapped.fields.reporter,
    description: "", // the description comment is written once, at creation
    requirements,
    statusChanges,
    attachments: newAttachments,
    budget: args.attachmentBudget,
    alreadySynced: link.syncedAttachmentIds,
  });

  await db.saveLink(env, {
    pairId: pair.id,
    visiId: visi.id,
    issueUuid: link.issueUuid,
    visiUpdatedAt: visi.updatedAt,
    shadow: { ...link.shadow, ...mapped.fields },
    syncedAttachmentIds,
    syncedRequirementIds: [...link.syncedRequirementIds, ...requirements.map((r) => r.id)],
    statusHistoryCursor: latestTimestamp(statusChanges) ?? link.statusHistoryCursor,
    state: "ok",
    lastError: null,
  });

  totals.updated++;
  if (conflicts.length > 0) totals.conflicts++;
  events.push({
    pairId: pair.id,
    visiId: visi.id,
    visiAlias: visi.alias,
    action: conflicts.length > 0 ? "conflict" : "update",
    detail: {
      issueUuid: link.issueUuid,
      changed,
      diff,
      // Visibuild wins, but record exactly what was written over.
      overwritten: conflicts,
      warnings: mapped.warnings,
      attachments: attachmentNotes,
    },
  });
  return { attachmentsUsed, deferred };
}

// ---------------------------------------------------------------------------
// Comment content
// ---------------------------------------------------------------------------

function attachmentsFor(visi: Visi, batch: PairBatch, content: ContentOptions): ProjectAttachment[] {
  if (!content.attachments) return [];
  return visi.projectAttachmentIds
    .map((id) => batch.attachmentsById.get(id))
    .filter((a): a is ProjectAttachment => Boolean(a));
}

function latestTimestamp(changes: VisiStatusChange[]): string | null {
  let latest: string | null = null;
  for (const c of changes) {
    if (c.timestamp && (!latest || c.timestamp > latest)) latest = c.timestamp;
  }
  return latest;
}

interface PostContentArgs {
  env: Env;
  cfg: AppConfig;
  pair: db.ProjectPair;
  conn: revizto.ReviztoConnection;
  mctx: MappingContext;
  visi: Visi;
  issueUuid: string;
  reporter: string;
  description: string;
  requirements: VisiRequirement[];
  statusChanges: VisiStatusChange[];
  attachments: ProjectAttachment[];
  budget: number;
  alreadySynced: string[];
}

/**
 * Post the non-field content: description, checklist answers, status history
 * and attachments. Text comments go in one call; each file goes in its own, so
 * one oversized or unreachable file cannot take the others down with it.
 */
async function postContent(args: PostContentArgs): Promise<{
  attachmentsUsed: number;
  /** Attachments left for the next run because the per-run cap was reached. */
  deferred: number;
  attachmentNotes: { id: string; filename?: string; skipped?: string }[];
  syncedAttachmentIds: string[];
}> {
  const { env, cfg, pair, conn, mctx, visi, issueUuid, reporter } = args;
  const reporterEmail = reporter || undefined;

  const textComments: revizto.IssueComment[] = [];
  if (args.description.trim()) {
    textComments.push({ kind: "text", uuid: crypto.randomUUID(), text: args.description, reporter: reporterEmail });
  }
  if (args.requirements.length > 0) {
    const body = renderRequirements(args.requirements);
    if (body) textComments.push({ kind: "text", uuid: crypto.randomUUID(), text: body, reporter: reporterEmail });
  }
  if (args.statusChanges.length > 0) {
    const body = renderStatusChanges(args.statusChanges, mctx);
    if (body) textComments.push({ kind: "text", uuid: crypto.randomUUID(), text: body, reporter: reporterEmail });
  }

  if (textComments.length > 0) {
    await revizto.addComments(env, conn, {
      projectUuid: pair.reviztoProjectUuid,
      projectId: pair.reviztoProjectId,
      issueUuid,
      comments: textComments,
    });
  }

  const notes: { id: string; filename?: string; skipped?: string }[] = [];
  const synced = [...args.alreadySynced];
  let used = 0;
  let deferred = 0;
  const maxBytes = cfg.limits.maxAttachmentMb * 1024 * 1024;

  for (const attachment of args.attachments) {
    if (used >= args.budget) {
      deferred++;
      notes.push({ id: attachment.id, skipped: "Per-run attachment cap reached; queued for the next run." });
      continue;
    }
    try {
      const file = await fetchAttachment(attachment.url, attachment.title, maxBytes);
      await revizto.addComments(env, conn, {
        projectUuid: pair.reviztoProjectUuid,
        projectId: pair.reviztoProjectId,
        issueUuid,
        comments: [
          { kind: "file", uuid: crypto.randomUUID(), filename: file.filename, blob: file.blob, reporter: reporterEmail },
        ],
      });
      synced.push(attachment.id);
      notes.push({ id: attachment.id, filename: file.filename });
      used++;
    } catch (e) {
      if (e instanceof ReviztoAuthError) throw e;
      // A file we will never be able to send is marked done, so it does not
      // stall every later run for this visi.
      if (e instanceof AttachmentSkipped) synced.push(attachment.id);
      notes.push({ id: attachment.id, skipped: (e as Error).message });
      console.error(`Attachment ${attachment.id} on visi ${visi.id}:`, e);
    }
  }

  return { attachmentsUsed: used, deferred, attachmentNotes: notes, syncedAttachmentIds: synced };
}
