/**
 * views/runs.ts – the sync log.
 *
 * The list answers "has it been running?"; the detail answers "what did it do
 * to this visi?". The detail matters most for conflicts: the sync overwrites a
 * hand edit in Revizto, so it has to show exactly what it wrote over.
 */
import type { Role } from "../auth";
import type { SyncEvent, SyncRun } from "../db";
import { MANAGED_FIELD_LABELS, type ManagedFieldKey } from "../revizto/types";
import { emptyState, message, pageHeader, renderValue, table, type PageMessage } from "./components";
import { actionBadge, esc, fmtDate, layout, runStatusBadge, type Theme } from "./layout";

export interface RunsPageOptions {
  theme: Theme;
  role: Role;
  message?: PageMessage;
  runs: SyncRun[];
}

export function runsPage(opts: RunsPageOptions): string {
  const content =
    opts.runs.length === 0
      ? emptyState("No syncs yet", "The sync runs hourly; the dashboard has a button to start one now.")
      : table(
          ["Started", "Trigger", "Outcome", "Created", "Updated", "Unchanged", "Overwritten", "Failed"],
          opts.runs.map((r) => [
            `<a href="/runs/${esc(r.id)}">${fmtDate(r.startedAt)}</a>`,
            esc(r.trigger === "cron" ? "Scheduled" : "Manual"),
            runStatusBadge(r.status),
            String(r.created),
            String(r.updated),
            String(r.skipped),
            r.conflicts > 0 ? `<span class="badge action-conflict">${r.conflicts}</span>` : `<span class="text-muted">–</span>`,
            r.failed > 0 ? `<span class="badge action-error">${r.failed}</span>` : `<span class="text-muted">–</span>`,
          ]),
        );

  const body = `<div class="container">
    ${pageHeader("Sync log", "Every run, and what it changed.")}
    ${message(opts.message)}
    <div class="card">${content}</div>
  </div>`;

  return layout({
    title: `Sync log · ${opts.theme.brandLabel}`,
    body,
    theme: opts.theme,
    nav: { role: opts.role, active: "runs" },
  });
}

// ---------------------------------------------------------------------------
// Run detail
// ---------------------------------------------------------------------------

export interface RunDetailOptions {
  theme: Theme;
  role: Role;
  run: SyncRun;
  events: SyncEvent[];
  /** pairId -> a readable project name. */
  pairNames: Map<string, string>;
  truncated: boolean;
}

interface EventDetail {
  issueUuid?: string;
  title?: string;
  changed?: ManagedFieldKey[];
  diff?: Partial<Record<ManagedFieldKey, { old: unknown; new: unknown }>>;
  overwritten?: { field: ManagedFieldKey; ours: unknown; theirs: unknown }[];
  warnings?: string[];
  attachments?: { id: string; filename?: string; skipped?: string }[];
  reason?: string;
  message?: string;
  error?: string;
  fatal?: boolean;
}

function fieldLabel(key: string): string {
  return MANAGED_FIELD_LABELS[key as ManagedFieldKey] ?? key;
}

function renderDetail(detail: EventDetail): string {
  const parts: string[] = [];

  if (detail.reason) parts.push(`<div>${esc(detail.reason)}</div>`);
  if (detail.message) parts.push(`<div class="text-error">${esc(detail.message)}</div>`);
  if (detail.error) parts.push(`<div class="text-muted">Earlier error: ${esc(detail.error)}</div>`);
  if (detail.title) parts.push(`<div><strong>${esc(detail.title)}</strong></div>`);

  if (detail.diff && Object.keys(detail.diff).length) {
    const rows = Object.entries(detail.diff)
      .map(
        ([key, pair]) =>
          `<li>${esc(fieldLabel(key))}: ${renderValue(pair?.old)} <span aria-hidden="true">→</span> ${renderValue(pair?.new)}</li>`,
      )
      .join("");
    parts.push(`<ul class="event-list">${rows}</ul>`);
  } else if (detail.changed?.length) {
    parts.push(`<div>Changed: ${detail.changed.map((c) => esc(fieldLabel(c))).join(", ")}</div>`);
  }

  if (detail.overwritten?.length) {
    // Visibuild is the source of truth, so this is expected rather than an
    // error – but it is the one thing an operator will want to see.
    const rows = detail.overwritten
      .map(
        (o) =>
          `<li>${esc(fieldLabel(o.field))}: Revizto held ${renderValue(o.theirs)}, last written by this sync as ${renderValue(o.ours)}</li>`,
      )
      .join("");
    parts.push(`<div class="event-note"><strong>Overwrote a manual change in Revizto</strong><ul class="event-list">${rows}</ul></div>`);
  }

  if (detail.attachments?.length) {
    const uploaded = detail.attachments.filter((a) => a.filename);
    const skipped = detail.attachments.filter((a) => a.skipped);
    if (uploaded.length) {
      parts.push(`<div class="text-muted">Attachments: ${uploaded.map((a) => esc(a.filename!)).join(", ")}</div>`);
    }
    for (const s of skipped) {
      parts.push(`<div class="text-muted">Attachment skipped: ${esc(s.skipped!)}</div>`);
    }
  }

  if (detail.warnings?.length) {
    parts.push(
      `<ul class="event-list text-muted">${detail.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`,
    );
  }

  return parts.join("") || `<span class="text-muted">–</span>`;
}

export function runDetailPage(opts: RunDetailOptions): string {
  const { run } = opts;

  const summary = `<div class="card">
    <dl class="detail-dl">
      <dt>Outcome</dt><dd>${runStatusBadge(run.status)}</dd>
      <dt>Trigger</dt><dd>${esc(run.trigger === "cron" ? "Scheduled" : "Manual")}</dd>
      <dt>Started</dt><dd>${fmtDate(run.startedAt)}</dd>
      <dt>Finished</dt><dd>${run.finishedAt ? fmtDate(run.finishedAt) : `<span class="text-muted">still running</span>`}</dd>
      <dt>Result</dt><dd>${run.created} created · ${run.updated} updated · ${run.skipped} unchanged · ${run.conflicts} overwritten · ${run.failed} failed</dd>
      ${run.message ? `<dt>Note</dt><dd>${esc(run.message)}</dd>` : ""}
    </dl>
  </div>`;

  const rows = opts.events.map((e) => [
    actionBadge(e.action),
    e.visiAlias ? `<strong>${esc(e.visiAlias)}</strong>` : e.visiId ? `<code>${esc(e.visiId.slice(0, 8))}</code>` : `<span class="text-muted">–</span>`,
    e.pairId ? esc(opts.pairNames.get(e.pairId) ?? "") : "",
    renderDetail((e.detail ?? {}) as EventDetail),
  ]);

  const events =
    rows.length === 0
      ? emptyState("Nothing to show", "This run touched no visis.")
      : table(["", "Visi", "Project", "What happened"], rows, "data-table event-table");

  const body = `<div class="container">
    ${pageHeader("Sync run", "", `<a class="btn btn-ghost" href="/runs">Back to the log</a>`)}
    ${summary}
    <p class="form-section-title">Detail</p>
    <div class="card">
      ${events}
      ${opts.truncated ? `<p class="field-hint">Only the first ${opts.events.length} events are shown.</p>` : ""}
    </div>
  </div>`;

  return layout({
    title: `Sync run · ${opts.theme.brandLabel}`,
    body,
    theme: opts.theme,
    nav: { role: opts.role, active: "runs" },
  });
}
