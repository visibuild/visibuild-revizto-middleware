/**
 * views/mapping.ts – the per-pair mapping editor.
 *
 * This is where a visi becomes a Revizto issue: which status maps to which
 * status, who a visi's assignee is on the Revizto side, and how a Visibuild
 * location tree flattens onto Revizto's five location tags.
 *
 * Two conventions run through the whole form:
 *
 *  - a blank select means "fall back", never "clear". Leaving a user unmapped
 *    means match them by email; leaving a type rule unmapped means use the
 *    default type. Only the explicit defaults at the bottom end the chain.
 *  - rule fields are namespaced (`subtype:`, `type:`, `category:`) and read
 *    most-specific first, so a subtype rule beats a type rule beats a category.
 */
import type { Role } from "../auth";
import { DERIVED_TAG_LABELS, type DerivedTags, type PairMapping } from "../config";
import type { ProjectPair } from "../db";
import { LOCATION_FIELDS, REVIZTO_PRIORITIES, type ReviztoIssueStatus, type ReviztoIssueType, type ReviztoMember } from "../revizto/types";
import type { LocationNode } from "../visibuild/resolve";
import { VISI_CATEGORIES, VISI_STATUSES, type Subtype } from "../visibuild/types";
import { checkbox, message, pageHeader, select, type PageMessage } from "./components";
import { esc, humanise, layout, type Theme } from "./layout";

/** A Visibuild project member, as the mapping table shows them. */
export interface MappableUser {
  id: string; // ProjectUser id – what a visi's assigneeId refers to
  name: string;
  email: string;
  companyName: string;
}

export interface MappableCompany {
  id: string; // ProjectCompany id
  name: string;
}

export interface MappingPageOptions {
  theme: Theme;
  role: Role;
  message?: PageMessage;
  pair: ProjectPair;
  mapping: PairMapping;
  linked: number;
  errored: number;

  /** Null when the Revizto workflow settings could not be loaded. */
  reviztoStatuses: ReviztoIssueStatus[] | null;
  reviztoTypes: ReviztoIssueType[] | null;
  reviztoMembers: ReviztoMember[] | null;
  reviztoError?: string;

  visibuildUsers: MappableUser[];
  visibuildCompanies: MappableCompany[];
  locations: LocationNode[];
  subtypes: Subtype[];
  /** Visi types worth offering: the documented list plus anything already mapped. */
  visiTypes: string[];
  visibuildError?: string;
}

/** Locations beyond this are not listed individually; the depth rule still covers them. */
const LOCATION_OVERRIDE_LIMIT = 250;

function memberOptions(
  members: ReviztoMember[],
  blankLabel: string,
): { value: string; label: string }[] {
  return [
    { value: "", label: blankLabel },
    ...members.map((m) => ({
      value: m.email,
      label: m.fullname ? `${m.fullname} (${m.email})` : m.email,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function titleSection(m: PairMapping): string {
  return `<div class="form-group">
    <label for="titleTemplate">Issue title</label>
    <input type="text" id="titleTemplate" name="titleTemplate" value="${esc(m.titleTemplate)}">
    <p class="field-hint">
      Available placeholders: <code>{alias}</code>, <code>{title}</code>, <code>{type}</code>,
      <code>{category}</code>, <code>{location}</code>. Revizto truncates a title at 255 characters.
    </p>
  </div>`;
}

function statusSection(opts: MappingPageOptions): string {
  const statuses = opts.reviztoStatuses;
  if (!statuses) {
    return `<p class="field-hint">${esc(opts.reviztoError || "Revizto's issue statuses could not be loaded.")}</p>`;
  }

  const options = [
    { value: "", label: "Use the default status" },
    ...statuses.map((s) => ({ value: s.uuid, label: s.category ? `${s.name} (${s.category})` : s.name })),
  ];

  const rows = VISI_STATUSES.map(
    (status) => `<div class="map-row">
      <span class="map-from">${esc(humanise(status))}</span>
      <span class="map-arrow" aria-hidden="true">→</span>
      ${select(`status:${status}`, options, opts.mapping.statuses[status] ?? "")}
    </div>`,
  ).join("");

  const defaultOptions = [{ value: "", label: "None – visis with an unmapped status are skipped" }, ...options.slice(1)];

  return `${rows}
    <div class="form-group" style="margin-top:14px">
      <label for="defaultStatus">Default status</label>
      ${select("defaultStatus", defaultOptions, opts.mapping.defaultStatus, { id: "defaultStatus" })}
      <p class="field-hint">Used for any visi status left unmapped above.</p>
    </div>`;
}

function typeSection(opts: MappingPageOptions): string {
  const types = opts.reviztoTypes;
  if (!types) {
    return `<p class="field-hint">${esc(opts.reviztoError || "Revizto's issue types could not be loaded.")}</p>`;
  }

  const options = [
    { value: "", label: "Use the default type" },
    ...types.map((t) => ({ value: t.uuid, label: t.isDefault ? `${t.name} (default)` : t.name })),
  ];

  const rule = (key: string, label: string, hint?: string) => `<div class="map-row">
    <span class="map-from">${esc(label)}${hint ? ` <span class="text-muted">${esc(hint)}</span>` : ""}</span>
    <span class="map-arrow" aria-hidden="true">→</span>
    ${select(`type:${key}`, options, opts.mapping.types[key] ?? "")}
  </div>`;

  const categoryRows = VISI_CATEGORIES.map((c) => rule(`category:${c}`, humanise(c))).join("");
  const typeRows = opts.visiTypes.map((t) => rule(`type:${t}`, humanise(t))).join("");
  const subtypeRows = opts.subtypes
    .map((s) => rule(`subtype:${s.id}`, s.name, s.visiCategory ? humanise(s.visiCategory) : undefined))
    .join("");

  const defaultOptions = [{ value: "", label: "None – visis with no type rule are skipped" }, ...options.slice(1)];

  return `<p class="field-hint" style="margin-bottom:12px">
      Rules are read most-specific first: a subtype rule wins over a type rule, which wins over a category rule.
    </p>
    <p class="map-group-title">By category</p>
    ${categoryRows}
    <p class="map-group-title">By type</p>
    ${typeRows}
    ${subtypeRows ? `<p class="map-group-title">By subtype</p>${subtypeRows}` : ""}
    <div class="form-group" style="margin-top:14px">
      <label for="defaultType">Default type</label>
      ${select("defaultType", defaultOptions, opts.mapping.defaultType, { id: "defaultType" })}
    </div>`;
}

function userSection(opts: MappingPageOptions): string {
  const members = opts.reviztoMembers;
  if (!members) {
    return `<p class="field-hint">${esc(opts.reviztoError || "The Revizto project's members could not be loaded.")}</p>`;
  }
  if (opts.visibuildUsers.length === 0) {
    return `<p class="field-hint">${esc(opts.visibuildError || "No Visibuild project members were returned.")}</p>`;
  }

  const memberEmails = new Set(members.map((m) => m.email));

  // Anyone whose Visibuild email already exists in the Revizto project needs no
  // mapping at all, so the form says so rather than making the operator confirm
  // a hundred rows that already work.
  const rows = opts.visibuildUsers
    .map((u) => {
      const autoMatched = u.email && memberEmails.has(u.email);
      const blankLabel = autoMatched
        ? `Matched by email (${u.email})`
        : "Not matched – falls back to the default assignee";
      return `<div class="map-row">
        <span class="map-from">
          ${esc(u.name || u.email || u.id)}
          <span class="text-muted">${esc([u.email, u.companyName].filter(Boolean).join(" · "))}</span>
        </span>
        <span class="map-arrow" aria-hidden="true">→</span>
        ${select(`user:${u.id}`, memberOptions(members, blankLabel), opts.mapping.users[u.id] ?? "")}
      </div>`;
    })
    .join("");

  const unmatched = opts.visibuildUsers.filter((u) => !u.email || !memberEmails.has(u.email)).length;

  return `<p class="field-hint" style="margin-bottom:12px">
      Both systems key on email address, so a member with the same email on each side needs no mapping.
      ${
        unmatched > 0
          ? `<strong>${unmatched} ${unmatched === 1 ? "person has" : "people have"} no matching Revizto member</strong> – map them below, or let them fall back to the default assignee.`
          : "Every Visibuild member has a matching Revizto member."
      }
    </p>
    ${rows}`;
}

function companySection(opts: MappingPageOptions): string {
  const members = opts.reviztoMembers;
  if (!members || opts.visibuildCompanies.length === 0) return "";

  const rows = opts.visibuildCompanies
    .map(
      (c) => `<div class="map-row">
        <span class="map-from">${esc(c.name)}</span>
        <span class="map-arrow" aria-hidden="true">→</span>
        ${select(
          `company:${c.id}`,
          memberOptions(members, "Falls back to the default assignee"),
          opts.mapping.companies[c.id] ?? "",
        )}
      </div>`,
    )
    .join("");

  return `<p class="field-hint" style="margin-bottom:12px">
      A visi can be assigned to a company rather than a person. Revizto only accepts an individual,
      so nominate who receives that company's visis.
    </p>
    ${rows}`;
}

function defaultsSection(opts: MappingPageOptions): string {
  const members = opts.reviztoMembers ?? [];
  return `<div class="form-group">
      <label for="defaultAssignee">Default assignee</label>
      ${select(
        "defaultAssignee",
        memberOptions(members, "None – Revizto assigns the connected user"),
        opts.mapping.defaultAssignee,
        { id: "defaultAssignee" },
      )}
      <p class="field-hint">Used when neither the person nor their company maps to a Revizto member.</p>
    </div>
    <div class="form-group">
      <label for="defaultReporter">Default reporter</label>
      ${select(
        "defaultReporter",
        memberOptions(members, "None – Revizto uses the connected user"),
        opts.mapping.defaultReporter,
        { id: "defaultReporter" },
      )}
      <p class="field-hint">Used when the visi's creator has no matching Revizto member.</p>
    </div>`;
}

function locationSection(opts: MappingPageOptions): string {
  const fieldOptions = [
    { value: "", label: "Don't map this level" },
    ...LOCATION_FIELDS.map((f) => ({ value: f, label: humanise(f) })),
  ];

  const maxDepth = opts.locations.reduce((max, l) => Math.max(max, l.depth), 0);
  // Always offer at least four rungs, so a shallow project can still grow.
  const depths = Array.from({ length: Math.max(maxDepth, 4) }, (_, i) => i + 1);

  const depthRows = depths
    .map((d) => {
      const sample = opts.locations.find((l) => l.depth === d);
      return `<div class="map-row">
        <span class="map-from">
          Level ${d}
          ${sample ? `<span class="text-muted">e.g. ${esc(sample.name)}</span>` : ""}
        </span>
        <span class="map-arrow" aria-hidden="true">→</span>
        ${select(`depth:${d}`, fieldOptions, opts.mapping.locationDepths[String(d)] ?? "")}
      </div>`;
    })
    .join("");

  const overridable = opts.locations
    .filter((l) => l.depth > 0)
    .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")))
    .slice(0, LOCATION_OVERRIDE_LIMIT);

  const overrideRows = overridable
    .map((l) => {
      const current = opts.mapping.locationOverrides[l.id] ?? {};
      const inputs = LOCATION_FIELDS.map(
        (f) =>
          `<input type="text" name="loc:${esc(l.id)}:${esc(f)}" value="${esc(current[f] ?? "")}"
             placeholder="${esc(humanise(f))}" aria-label="${esc(`${l.name} ${f}`)}">`,
      ).join("");
      return `<div class="loc-override">
        <div class="loc-override-name">${esc(l.path.slice(1).join(" / ") || l.name)}</div>
        <div class="loc-override-fields">${inputs}</div>
      </div>`;
    })
    .join("");

  const truncatedNote =
    opts.locations.length > LOCATION_OVERRIDE_LIMIT
      ? `<p class="field-hint">Showing the first ${LOCATION_OVERRIDE_LIMIT} of ${opts.locations.length} locations. The rest still follow the level rules above.</p>`
      : "";

  return `<p class="field-hint" style="margin-bottom:12px">
      Revizto has five location tags. Assign each level of the Visibuild location tree to one of them –
      for a building that is usually tower, level, room.
    </p>
    ${depthRows}
    <p class="field-hint" style="margin-top:14px">
      <strong>Worth knowing:</strong> Revizto only accepts location tags when an issue is first created –
      there is no way to change them afterwards. Keep the <em>Location path</em> derived tag switched on
      below so a visi that later moves still shows the move in Revizto.
    </p>
    ${
      overrideRows
        ? `<details class="override-block">
             <summary>Per-location overrides (${overridable.length})</summary>
             <p class="field-hint">Anything entered here replaces the level rules for that location.</p>
             ${truncatedNote}
             ${overrideRows}
           </details>`
        : ""
    }`;
}

function tagSection(m: PairMapping): string {
  const derived = (Object.keys(DERIVED_TAG_LABELS) as (keyof DerivedTags)[])
    .map((key) => checkbox(`derived:${key}`, DERIVED_TAG_LABELS[key], m.derivedTags[key]))
    .join("");

  return `<div class="form-group">
      ${checkbox("tagPassthrough", "Copy the visi's own Visibuild tags across", m.tagPassthrough)}
    </div>
    <div class="form-group">
      <label for="tagPrefix">Tag prefix</label>
      <input type="text" id="tagPrefix" name="tagPrefix" value="${esc(m.tagPrefix)}" placeholder="e.g. vb:">
      <p class="field-hint">Optional. Prefixes every tag this sync writes, so they are easy to tell apart in Revizto.</p>
    </div>
    <p class="map-group-title">Also tag each issue with</p>
    <div class="checkbox-list">${derived}</div>`;
}

function prioritySection(opts: MappingPageOptions): string {
  const options = [
    { value: "", label: "Use the default priority" },
    ...REVIZTO_PRIORITIES.map((p) => ({ value: p, label: humanise(p) })),
  ];

  const rows = [
    ...VISI_CATEGORIES.map((c) => ({ key: `category:${c}`, label: humanise(c) })),
    ...opts.visiTypes.map((t) => ({ key: `type:${t}`, label: humanise(t) })),
  ]
    .map(
      ({ key, label }) => `<div class="map-row">
        <span class="map-from">${esc(label)}</span>
        <span class="map-arrow" aria-hidden="true">→</span>
        ${select(`prio:${key}`, options, opts.mapping.priorityRules[key] ?? "")}
      </div>`,
    )
    .join("");

  return `<p class="field-hint" style="margin-bottom:12px">
      A visi carries no priority of its own, so Revizto's priority is derived from its category or type.
    </p>
    ${rows}
    <div class="form-group" style="margin-top:14px">
      <label for="defaultPriority">Default priority</label>
      ${select(
        "defaultPriority",
        REVIZTO_PRIORITIES.map((p) => ({ value: p, label: humanise(p) })),
        opts.mapping.defaultPriority,
        { id: "defaultPriority" },
      )}
    </div>`;
}

function scopeSection(opts: MappingPageOptions): string {
  const f = opts.mapping.filters;
  const on = f !== null;
  const categories = VISI_CATEGORIES.map((c) =>
    checkbox(`scopeCategory`, humanise(c), Boolean(f?.categories.includes(c)), c),
  ).join("");
  const statuses = VISI_STATUSES.map((s) =>
    checkbox(`scopeStatus`, humanise(s), Boolean(f?.statuses.includes(s)), s),
  ).join("");

  return `<div class="form-group">
      ${checkbox("scopeOverride", "Use a different sync scope for this pair", on)}
      <p class="field-hint">Off means this pair follows the global scope set in Settings.</p>
    </div>
    <div class="form-group">
      <label>Categories</label>
      <div class="checkbox-list">${categories}</div>
      <p class="field-hint">Tick none to allow every category.</p>
    </div>
    <div class="form-group">
      <label>Statuses</label>
      <div class="checkbox-list">${statuses}</div>
      <p class="field-hint">Tick none to allow every status.</p>
    </div>
    <div class="form-group">
      ${checkbox("scopeRootOnly", "Root visis only", f ? f.rootOnly : true)}
      ${checkbox("scopeIncludeArchived", "Include archived visis", Boolean(f?.includeArchived))}
    </div>
    <p class="field-hint">
      The scope decides which visis are <em>created</em> in Revizto. A visi that has already been mirrored
      keeps syncing even if it later falls outside the scope, so its Revizto issue never goes stale.
    </p>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function mappingPage(opts: MappingPageOptions): string {
  const { pair } = opts;
  const readOnly = opts.role !== "admin";

  const actions = readOnly
    ? ""
    : `<form method="post" action="/pairs/${esc(pair.id)}/sync" style="display:inline">
         <button type="submit" class="btn btn-primary">Sync now</button>
       </form>
       <form method="post" action="/pairs/${esc(pair.id)}/toggle" style="display:inline">
         <button type="submit" class="btn btn-ghost">${pair.enabled ? "Pause sync" : "Resume sync"}</button>
       </form>`;

  const pausedNote =
    pair.enabled || readOnly
      ? ""
      : `<p class="field-hint" style="margin-top:-12px;margin-bottom:18px">
           This pair is paused, so the hourly sync skips it. <strong>Sync now</strong> still runs it,
           which is the quickest way to try a mapping change before resuming.
         </p>`;

  const summary = `<div class="card">
    <dl class="detail-dl">
      <dt>Visibuild project</dt><dd>${esc(pair.visibuildProjectName || pair.visibuildProjectId)}</dd>
      <dt>Revizto project</dt><dd>${esc(pair.reviztoProjectName || pair.reviztoProjectUuid)}</dd>
      <dt>Issues created</dt><dd>${opts.linked}${
        opts.errored > 0 ? ` <span class="badge action-error">${opts.errored} failing</span>` : ""
      }</dd>
      <dt>Synced up to</dt><dd>${
        pair.visiCursor ? esc(pair.visiCursor) : `<span class="text-muted">Never synced</span>`
      }</dd>
    </dl>
  </div>`;

  const dangerZone = readOnly
    ? ""
    : `<p class="form-section-title">Re-sync and removal</p>
       <div class="card">
         <div class="actions-row">
           <form method="post" action="/pairs/${esc(pair.id)}/reset">
             <button type="submit" class="btn btn-ghost">Re-read everything</button>
           </form>
           <form method="post" action="/pairs/${esc(pair.id)}/delete" data-confirm="Delete this pair and forget which Revizto issue each visi maps to? The issues themselves stay in Revizto.">
             <button type="submit" class="btn btn-ghost btn-danger">Delete pair</button>
           </form>
         </div>
         <p class="field-hint">
           <strong>Re-read everything</strong> clears the watermarks so the next run re-checks every visi.
           Existing issues are updated, not duplicated. <strong>Delete pair</strong> forgets the visi-to-issue
           links; the Revizto issues are left alone, so re-creating the pair afterwards would make duplicates.
         </p>
       </div>`;

  const form = `<form method="post" action="/pairs/${esc(pair.id)}" autocomplete="off">
    <div class="card">
      <p class="form-section-title">Title</p>
      ${titleSection(opts.mapping)}

      <p class="form-section-title">Statuses</p>
      ${statusSection(opts)}

      <p class="form-section-title">Issue types</p>
      ${typeSection(opts)}

      <p class="form-section-title">People</p>
      ${userSection(opts)}

      ${opts.visibuildCompanies.length ? `<p class="form-section-title">Companies</p>${companySection(opts)}` : ""}

      <p class="form-section-title">Fallbacks</p>
      ${defaultsSection(opts)}

      <p class="form-section-title">Locations</p>
      ${locationSection(opts)}

      <p class="form-section-title">Tags</p>
      ${tagSection(opts.mapping)}

      <p class="form-section-title">Priority</p>
      ${prioritySection(opts)}

      <p class="form-section-title">Visibility</p>
      <div class="form-group">
        ${select(
          "visibility",
          [
            { value: "1", label: "Visible to every project member" },
            { value: "0", label: "Visible to the author, reporter, assignee, watchers and admins" },
          ],
          String(opts.mapping.visibility),
          { id: "visibility" },
        )}
      </div>

      <p class="form-section-title">Sync scope</p>
      ${scopeSection(opts)}

      <div class="actions-row">
        <button type="submit" class="btn btn-primary">Save mapping</button>
        <a class="btn btn-ghost" href="/pairs">Back to projects</a>
      </div>
    </div>
  </form>`;

  const body = `<div class="container container--sm">
    ${pageHeader(
      pair.visibuildProjectName || "Project pair",
      `Mapping into ${pair.reviztoProjectName || "Revizto"}.`,
      actions,
    )}
    ${message(opts.message)}
    ${pausedNote}
    ${summary}
    ${readOnly ? `<p class="field-hint">Sign in as an admin to change the mapping.</p>` : form}
    ${dangerZone}
  </div>`;

  return layout({
    title: `${pair.visibuildProjectName || "Mapping"} · ${opts.theme.brandLabel}`,
    body,
    theme: opts.theme,
    nav: { role: opts.role, active: "pairs" },
  });
}
