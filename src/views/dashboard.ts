/**
 * views/dashboard.ts – the home page: is this thing working, and what did it
 * just do?
 *
 * Three questions, answered top to bottom: are both APIs connected, which
 * projects are being synced and how far has each got, and how did the last run
 * go. The "Sync now" button is here rather than buried in Settings because it
 * is the thing an operator reaches for when something looks stale.
 */
import type { ProjectPair, SyncRun } from "../db";
import type { ReviztoTokens } from "../revizto/types";
import { regionLabel } from "../revizto/types";
import type { Role } from "../auth";
import { definitionList, emptyState, message, pageHeader, table, type PageMessage } from "./components";
import { esc, fmtDate, healthBadge, layout, runStatusBadge, type Theme } from "./layout";

export interface PairStatus {
  pair: ProjectPair;
  linked: number;
  errored: number;
}

export interface DashboardOptions {
  theme: Theme;
  role: Role;
  message?: PageMessage;
  /** False until the D1 schema has been applied. */
  schemaReady: boolean;
  visibuildConnected: boolean;
  reviztoTokens: ReviztoTokens | null;
  reviztoConfigured: boolean;
  pairs: PairStatus[];
  lastRun: SyncRun | null;
}

function reviztoHealth(opts: DashboardOptions): { ok: boolean; label: string; detail: string } {
  const t = opts.reviztoTokens;
  if (!opts.reviztoConfigured) {
    return { ok: false, label: "Not configured", detail: "Add the Revizto app credentials in Settings." };
  }
  if (!t) return { ok: false, label: "Not connected", detail: "Connect Revizto from Settings." };
  if (t.needsReauth) {
    return {
      ok: false,
      label: "Reconnect needed",
      detail: t.lastError || "The stored Revizto authorisation has lapsed.",
    };
  }
  return {
    ok: true,
    label: "Connected",
    detail: `Acting as ${t.connectedName || t.connectedEmail} in ${regionLabel(t.region)}.`,
  };
}

function connectionCard(opts: DashboardOptions): string {
  const revizto = reviztoHealth(opts);
  const vb = opts.visibuildConnected;
  const reconnect =
    opts.role === "admin" && !revizto.ok
      ? ` <a class="btn btn-ghost btn-sm" href="/settings">Fix in Settings</a>`
      : "";

  return `<div class="card">
    ${definitionList([
      [
        "Visibuild",
        `${healthBadge(vb, vb ? "Connected" : "Not configured")} <span class="text-muted">${esc(
          vb ? "API credentials saved." : "Add the API credentials in Settings.",
        )}</span>`,
      ],
      [
        "Revizto",
        `${healthBadge(revizto.ok, revizto.label)} <span class="text-muted">${esc(revizto.detail)}</span>${reconnect}`,
      ],
    ])}
  </div>`;
}

function pairsCard(opts: DashboardOptions): string {
  if (opts.pairs.length === 0) {
    return `<div class="card">${emptyState(
      "No projects are being synced",
      "Pair a Visibuild project with a Revizto project to start mirroring its visis.",
      opts.role === "admin" ? `<a class="btn btn-primary" href="/pairs">Set up a project pair</a>` : "",
    )}</div>`;
  }

  const rows = opts.pairs.map((p) => [
    `<a href="/pairs/${esc(p.pair.id)}"><strong>${esc(p.pair.visibuildProjectName || p.pair.visibuildProjectId)}</strong></a>`,
    esc(p.pair.reviztoProjectName || p.pair.reviztoProjectUuid),
    p.pair.enabled ? `<span class="badge run-ok">On</span>` : `<span class="badge action-skip">Paused</span>`,
    String(p.linked),
    p.errored > 0 ? `<span class="badge action-error">${p.errored}</span>` : `<span class="text-muted">–</span>`,
    p.pair.visiCursor ? fmtDate(p.pair.visiCursor) : `<span class="text-muted">Never synced</span>`,
  ]);

  return `<div class="card">${table(
    ["Visibuild project", "Revizto project", "Sync", "Issues", "Failing", "Synced up to"],
    rows,
  )}</div>`;
}

function lastRunCard(opts: DashboardOptions): string {
  const run = opts.lastRun;
  if (!run) {
    return `<div class="card">${emptyState(
      "Nothing has synced yet",
      "The sync runs hourly. You can also start one now.",
    )}</div>`;
  }
  return `<div class="card">
    ${definitionList([
      ["Outcome", `${runStatusBadge(run.status)} <a href="/runs/${esc(run.id)}">View detail</a>`],
      ["Started", fmtDate(run.startedAt)],
      ["Finished", run.finishedAt ? fmtDate(run.finishedAt) : `<span class="text-muted">still running</span>`],
      [
        "Result",
        `${run.created} created · ${run.updated} updated · ${run.skipped} unchanged` +
          (run.conflicts > 0 ? ` · <span class="badge action-conflict">${run.conflicts} overwritten</span>` : "") +
          (run.failed > 0 ? ` · <span class="badge action-error">${run.failed} failed</span>` : ""),
      ],
      ...(run.message ? ([["Note", esc(run.message)]] as [string, string][]) : []),
    ])}
  </div>`;
}

export function dashboardPage(opts: DashboardOptions): string {
  const syncButton =
    opts.role === "admin"
      ? `<form method="post" action="/sync" style="display:inline">
           <button type="submit" class="btn btn-primary">Sync now</button>
         </form>`
      : "";

  const schemaWarning = opts.schemaReady
    ? ""
    : `<div class="message error">The database tables are missing. Run <code>npm run db:migrate</code> (or <code>db:migrate:local</code> for local dev) to apply <code>schema.sql</code>.</div>`;

  const body = `<div class="container">
    ${pageHeader("Dashboard", "Visibuild visis mirrored into Revizto issues.", syncButton)}
    ${message(opts.message)}
    ${schemaWarning}

    <p class="form-section-title">Connections</p>
    ${connectionCard(opts)}

    <p class="form-section-title">Projects</p>
    ${pairsCard(opts)}

    <p class="form-section-title">Last sync</p>
    ${lastRunCard(opts)}
  </div>`;

  return layout({
    title: `Dashboard · ${opts.theme.brandLabel}`,
    body,
    theme: opts.theme,
    nav: { role: opts.role, active: "dashboard" },
  });
}
