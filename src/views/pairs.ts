/**
 * views/pairs.ts – the project pairs: which Visibuild project mirrors into
 * which Revizto project.
 *
 * Creating a pair is a three-step pick (Visibuild project, Revizto licence,
 * Revizto project) done in one form: the licence select auto-submits so the
 * project list can be fetched for it, which keeps the flow to a single page
 * without any client-side state.
 */
import type { ProjectPair } from "../db";
import type { Role } from "../auth";
import type { ReviztoLicense, ReviztoProject } from "../revizto/types";
import type { Project as VisibuildProject } from "../visibuild/types";
import { emptyState, message, pageHeader, select, table, type PageMessage } from "./components";
import { esc, fmtDate, layout, type Theme } from "./layout";

export interface PairsPageOptions {
  theme: Theme;
  role: Role;
  message?: PageMessage;
  pairs: ProjectPair[];
  /** Null when Visibuild is not connected or the project list failed to load. */
  visibuildProjects: VisibuildProject[] | null;
  visibuildError?: string;
  /** Null when Revizto is not connected. */
  licenses: ReviztoLicense[] | null;
  reviztoError?: string;
  /** The licence currently selected in the form, and its projects. */
  selectedLicense: string;
  reviztoProjects: ReviztoProject[] | null;
}

function existingPairs(opts: PairsPageOptions): string {
  if (opts.pairs.length === 0) {
    return `<div class="card">${emptyState(
      "No project pairs yet",
      "Pick a Visibuild project and the Revizto project its visis should appear in.",
    )}</div>`;
  }

  const rows = opts.pairs.map((p) => [
    `<a href="/pairs/${esc(p.id)}"><strong>${esc(p.visibuildProjectName || p.visibuildProjectId)}</strong></a>`,
    esc(p.reviztoProjectName || p.reviztoProjectUuid),
    p.enabled ? `<span class="badge run-ok">On</span>` : `<span class="badge action-skip">Paused</span>`,
    p.visiCursor ? fmtDate(p.visiCursor) : `<span class="text-muted">Never synced</span>`,
    `<a class="btn btn-ghost btn-sm" href="/pairs/${esc(p.id)}">Mapping</a>`,
  ]);

  return `<div class="card">${table(
    ["Visibuild project", "Revizto project", "Sync", "Synced up to", ""],
    rows,
  )}</div>`;
}

function newPairForm(opts: PairsPageOptions): string {
  if (opts.visibuildProjects === null) {
    return `<div class="card"><p class="field-hint">${esc(
      opts.visibuildError || "Connect Visibuild in Settings to load its project list.",
    )}</p></div>`;
  }
  if (opts.licenses === null) {
    return `<div class="card"><p class="field-hint">${esc(
      opts.reviztoError || "Connect Revizto in Settings to load its licences and projects.",
    )}</p></div>`;
  }

  const visibuildOptions = opts.visibuildProjects.map((p) => ({
    value: p.id,
    label: p.projectIdentifier ? `${p.name} (${p.projectIdentifier})` : p.name,
  }));

  const licenseOptions = [
    { value: "", label: "Choose a licence…" },
    ...opts.licenses.map((l) => ({ value: l.uuid, label: l.name })),
  ];

  // The licence select posts back to itself so the project list can be loaded
  // for the chosen licence; without a licence there is nothing to choose from.
  const projectField =
    opts.reviztoProjects === null
      ? `<p class="field-hint">Choose a licence to load its projects.</p>`
      : opts.reviztoProjects.length === 0
        ? `<p class="field-hint">That licence has no projects you can reach.</p>`
        : select(
            "reviztoProject",
            opts.reviztoProjects
              .filter((p) => !p.archived)
              .map((p) => ({ value: `${p.uuid}|${p.id}|${p.title}`, label: p.title })),
            "",
            { id: "reviztoProject" },
          );

  return `<div class="card">
    <form method="get" action="/pairs">
      <div class="form-group">
        <label for="license">Revizto licence</label>
        ${select("license", licenseOptions, opts.selectedLicense, { id: "license", autosubmit: true })}
        <p class="field-hint">Projects live inside a licence, so pick one to load its project list.</p>
      </div>
      <noscript><button type="submit" class="btn btn-ghost">Load projects</button></noscript>
    </form>

    <form method="post" action="/pairs">
      <input type="hidden" name="license" value="${esc(opts.selectedLicense)}">
      <div class="form-group">
        <label for="visibuildProject">Visibuild project</label>
        ${select("visibuildProject", visibuildOptions, "", { id: "visibuildProject" })}
      </div>
      <div class="form-group">
        <label for="reviztoProject">Revizto project</label>
        ${projectField}
      </div>
      <div class="actions-row">
        <button type="submit" class="btn btn-primary"${opts.reviztoProjects?.length ? "" : " disabled"}>
          Create pair
        </button>
      </div>
      <p class="field-hint">
        Nothing syncs until you map statuses and types on the pair's mapping page.
      </p>
    </form>
  </div>`;
}

export function pairsPage(opts: PairsPageOptions): string {
  const body = `<div class="container">
    ${pageHeader("Projects", "Each pair mirrors one Visibuild project's visis into one Revizto project.")}
    ${message(opts.message)}
    ${existingPairs(opts)}
    ${opts.role === "admin" ? `<p class="form-section-title">Add a pair</p>${newPairForm(opts)}` : ""}
  </div>`;

  return layout({
    title: `Projects · ${opts.theme.brandLabel}`,
    body,
    theme: opts.theme,
    nav: { role: opts.role, active: "pairs" },
  });
}
