/**
 * sync/mapping.ts – turn a Visibuild visi into Revizto issue fields.
 *
 * Everything here is pure: no network, no bindings, no clock beyond what is
 * passed in. That is deliberate – the mapping is the part most likely to need
 * adjusting, and it is the part worth having tests around.
 */
import type { PairMapping } from "../config";
import { humanise } from "../labels";
import {
  LOCATION_FIELDS,
  type FieldDiffInput,
  type LocationField,
  type LocationProperties,
  type ManagedFieldKey,
  type ManagedFields,
  type ReviztoPriority,
} from "./mapping-types";
import type { LocationNode } from "../visibuild/resolve";
import type { Visi, VisiRequirement, VisiStatusChange } from "../visibuild/types";

/** What the mapper needs to know about the visi's project. */
export interface MappingContext {
  /** locationId -> node, from `buildLocationTree`. */
  locations: Map<string, LocationNode>;
  /** ProjectUser id -> the Visibuild user behind it. */
  projectUsers: Map<string, { email: string; name: string; companyName: string }>;
  /** ProjectCompany id -> company name. */
  projectCompanies: Map<string, string>;
  /** Subtype id -> name. */
  subtypeNames: Map<string, string>;
  /** ProjectMilestone id -> name. */
  milestoneNames: Map<string, string>;
  /** DefectRound id -> name. */
  defectRoundNames: Map<string, string>;
  /** Visi id -> its Visibuild tag names. */
  visiTagNames: Map<string, string[]>;
}

export interface MappedIssue {
  fields: ManagedFields;
  /** Revizto's location tags. Writable at creation only. */
  location: LocationProperties;
  /** Revizto's own creation timestamp, so the issue dates from the visi. */
  created: string;
  /** Non-fatal notes worth showing in the sync log, e.g. an unmapped status. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Revizto wants "YYYY-MM-DD HH:MM:SS" (UTC), not ISO 8601. */
export function toReviztoTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** A date-only value ("2026-01-15") becomes midnight on that day. */
export function dateToReviztoTimestamp(date: string | null | undefined): string {
  if (!date) return "";
  const trimmed = String(date).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed} 00:00:00`;
  return toReviztoTimestamp(trimmed);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Revizto caps a title at 255 characters. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

/**
 * Look up a namespaced rule, most specific first: an explicit subtype rule
 * beats a type rule, which beats a category rule.
 */
function lookupRule<T extends string>(
  rules: Record<string, T>,
  visi: Visi,
): T | undefined {
  if (visi.subtypeId && rules[`subtype:${visi.subtypeId}`]) return rules[`subtype:${visi.subtypeId}`];
  if (visi.type && rules[`type:${visi.type}`]) return rules[`type:${visi.type}`];
  if (visi.category && rules[`category:${visi.category}`]) return rules[`category:${visi.category}`];
  return undefined;
}

/**
 * Resolve a visi's assignee to a Revizto member email.
 *
 * The chain is: an explicit mapping for this ProjectUser or ProjectCompany,
 * then the Visibuild user's own email (both systems key on email, so an
 * unmapped user usually still lands correctly), then the configured default.
 */
export function resolveAssignee(
  visi: Visi,
  mapping: PairMapping,
  ctx: MappingContext,
): { email: string; source: string } {
  const id = visi.assigneeId;
  if (id) {
    if (visi.assigneeType === "ProjectCompany") {
      const mapped = mapping.companies[id];
      if (mapped) return { email: mapped, source: "company mapping" };
    } else {
      const mapped = mapping.users[id];
      if (mapped) return { email: mapped, source: "user mapping" };
      const email = ctx.projectUsers.get(id)?.email;
      if (email) return { email, source: "matched by email" };
    }
  }
  if (mapping.defaultAssignee) return { email: mapping.defaultAssignee, source: "default assignee" };
  return { email: "", source: "unresolved" };
}

export function resolveReporter(
  visi: Visi,
  mapping: PairMapping,
  ctx: MappingContext,
): { email: string; source: string } {
  const id = visi.createdByProjectUserId;
  if (id) {
    const mapped = mapping.users[id];
    if (mapped) return { email: mapped, source: "user mapping" };
    const email = ctx.projectUsers.get(id)?.email;
    if (email) return { email, source: "matched by email" };
  }
  if (mapping.defaultReporter) return { email: mapping.defaultReporter, source: "default reporter" };
  return { email: "", source: "unresolved" };
}

/**
 * Map the visi's location onto Revizto's five location tags.
 *
 * The default rule assigns each depth of the Visibuild location tree to a
 * Revizto field (depth 1 -> area, depth 2 -> level, depth 3 -> room). A
 * per-location override wins outright, for the locations that do not fit.
 */
export function resolveLocation(
  visi: Visi,
  mapping: PairMapping,
  ctx: MappingContext,
): LocationProperties {
  const empty: LocationProperties = { level: null, room: null, area: null, zone: null, space: null };
  if (!visi.locationId) return empty;

  const override = mapping.locationOverrides[visi.locationId];
  if (override) {
    const out = { ...empty };
    for (const f of LOCATION_FIELDS) if (override[f]) out[f] = override[f]!;
    return out;
  }

  const node = ctx.locations.get(visi.locationId);
  if (!node) return empty;

  const out = { ...empty };
  // path[0] is the project root, which carries no useful information, so the
  // depth keys line up with path indexes from 1.
  for (let depth = 1; depth < node.path.length; depth++) {
    const target = mapping.locationDepths[String(depth)];
    if (!target) continue;
    out[target as LocationField] = node.path[depth];
  }
  return out;
}

/** The full location path, e.g. "North Tower / Level 3 / Apartment 314". */
export function locationPath(visi: Visi, ctx: MappingContext): string {
  if (!visi.locationId) return "";
  const node = ctx.locations.get(visi.locationId);
  if (!node) return "";
  // Drop the root: it is the project itself.
  return node.path.slice(1).join(" / ") || node.name;
}

export function resolveTags(visi: Visi, mapping: PairMapping, ctx: MappingContext): string[] {
  const tags = new Set<string>();
  const add = (t: string | null | undefined) => {
    const v = collapse(String(t ?? ""));
    if (v) tags.add(mapping.tagPrefix ? `${mapping.tagPrefix}${v}` : v);
  };

  if (mapping.tagPassthrough) {
    for (const t of ctx.visiTagNames.get(visi.id) ?? []) add(t);
  }
  const d = mapping.derivedTags;
  if (d.type) add(humanise(visi.type));
  if (d.category) add(humanise(visi.category));
  if (d.subtype && visi.subtypeId) add(ctx.subtypeNames.get(visi.subtypeId));
  if (d.milestone && visi.projectMilestoneId) add(ctx.milestoneNames.get(visi.projectMilestoneId));
  if (d.defectRound && visi.defectRoundId) add(ctx.defectRoundNames.get(visi.defectRoundId));
  if (d.location) add(locationPath(visi, ctx));
  if (d.alias) add(visi.alias);

  // Sorted, so a diff only fires when the set genuinely changes.
  return [...tags].sort((a, b) => a.localeCompare(b));
}

export function renderTitle(visi: Visi, mapping: PairMapping, ctx: MappingContext): string {
  const substitutions: Record<string, string> = {
    alias: visi.alias ?? "",
    title: visi.title ?? "",
    type: humanise(visi.type),
    category: humanise(visi.category),
    location: locationPath(visi, ctx),
  };
  const rendered = mapping.titleTemplate.replace(/\{(\w+)\}/g, (_, key: string) => substitutions[key] ?? "");
  // A template like "{alias} {title}" leaves a stray space when the alias is
  // missing, so collapse before truncating.
  return truncate(collapse(rendered) || visi.title || "Untitled visi", 255);
}

/** Map a visi onto the Revizto fields this middleware manages. */
export function mapVisi(visi: Visi, mapping: PairMapping, ctx: MappingContext): MappedIssue {
  const warnings: string[] = [];

  const status = mapping.statuses[visi.status] || mapping.defaultStatus;
  if (!status) {
    warnings.push(`No Revizto status mapped for visi status "${visi.status}".`);
  } else if (!mapping.statuses[visi.status]) {
    warnings.push(`Visi status "${visi.status}" is unmapped; used the default status.`);
  }

  const type = lookupRule(mapping.types, visi) || mapping.defaultType;
  if (!type) {
    warnings.push(`No Revizto issue type mapped for visi type "${visi.type ?? visi.category ?? "unknown"}".`);
  }

  const assignee = resolveAssignee(visi, mapping, ctx);
  if (!assignee.email) {
    warnings.push("No Revizto assignee could be resolved; Revizto will assign the connected user.");
  }
  const reporter = resolveReporter(visi, mapping, ctx);

  const priority = (lookupRule<ReviztoPriority>(mapping.priorityRules, visi) ??
    mapping.defaultPriority) as ReviztoPriority;

  return {
    fields: {
      title: renderTitle(visi, mapping, ctx),
      customStatus: status,
      customType: type,
      assignee: assignee.email,
      reporter: reporter.email,
      deadline: dateToReviztoTimestamp(visi.dueDate),
      priority,
      tags: resolveTags(visi, mapping, ctx),
      visibility: mapping.visibility,
    },
    location: resolveLocation(visi, mapping, ctx),
    created: toReviztoTimestamp(visi.createdAt),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

export interface BuiltDiff {
  diff: FieldDiffInput;
  changed: ManagedFieldKey[];
}

/**
 * Build the `{old, new}` pairs for the fields that actually differ.
 *
 * `current` is what Revizto holds right now – either read back from Revizto or,
 * when nobody has touched the issue since, the shadow of what we last wrote.
 * Getting `old` wrong is not an error: Revizto simply drops that pair, which is
 * precisely why the engine prefers a freshly read value when it has one.
 *
 * A field missing from `current` is skipped rather than guessed at, since a
 * wrong `old` would silently lose the write.
 */
export function buildDiff(current: Partial<ManagedFields>, desired: ManagedFields): BuiltDiff {
  const diff: FieldDiffInput = {};
  const changed: ManagedFieldKey[] = [];

  const consider = <K extends ManagedFieldKey>(key: K) => {
    const oldValue = current[key];
    if (oldValue === undefined) return; // unknown current value – do not guess
    const newValue = desired[key];
    if (sameValue(oldValue, newValue)) return;
    // Revizto rejects a status or type change to an empty UUID; leave it alone.
    if ((key === "customStatus" || key === "customType") && !newValue) return;
    diff[key] = { old: oldValue, new: newValue };
    changed.push(key);
  };

  consider("title");
  consider("customStatus");
  consider("customType");
  consider("assignee");
  consider("reporter");
  consider("deadline");
  consider("priority");
  consider("tags");
  consider("visibility");

  return { diff, changed };
}

/**
 * Fields where Revizto's current value disagrees with what we last wrote –
 * i.e. someone edited the issue by hand. Visibuild wins, but the sync log
 * records what was overwritten.
 */
export function detectConflicts(
  shadow: Partial<ManagedFields>,
  live: Partial<ManagedFields>,
): { field: ManagedFieldKey; ours: unknown; theirs: unknown }[] {
  const out: { field: ManagedFieldKey; ours: unknown; theirs: unknown }[] = [];
  for (const key of Object.keys(shadow) as ManagedFieldKey[]) {
    const theirs = live[key];
    if (theirs === undefined) continue;
    if (!sameValue(shadow[key], theirs)) out.push({ field: key, ours: shadow[key], theirs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comment bodies
// ---------------------------------------------------------------------------

/** The description comment, optionally with a deep link back to the visi. */
export function renderDescription(visi: Visi, opts: { link?: string; includeLink: boolean }): string {
  const parts: string[] = [];
  const body = (visi.description ?? "").trim();
  if (body) parts.push(body);
  if (opts.includeLink && opts.link) {
    parts.push(`${visi.alias ? `${visi.alias} ` : ""}in Visibuild: ${opts.link}`);
  }
  return parts.join("\n\n");
}

/** One line per checklist answer, in the order the requirements are defined. */
export function renderRequirements(requirements: VisiRequirement[]): string {
  if (requirements.length === 0) return "";
  const lines = [...requirements]
    .sort((a, b) => a.order - b.order)
    .map((r) => {
      let value: string;
      if (r.values && r.values.length) value = r.values.join(", ");
      else if (r.type === "checkbox") value = r.value === "true" ? "Yes" : r.value === "false" ? "No" : "–";
      else if (r.type === "signature") value = r.value ? "Signed" : "Not signed";
      else value = (r.value ?? "").trim() || "–";
      return `${r.title || "(untitled)"}: ${value}`;
    });
  return `Visibuild checklist\n\n${lines.join("\n")}`;
}

/** One line per status change, oldest first. */
export function renderStatusChanges(changes: VisiStatusChange[], ctx: MappingContext): string {
  if (changes.length === 0) return "";
  const lines = [...changes]
    .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""))
    .map((c) => {
      const who = c.projectUserId ? ctx.projectUsers.get(c.projectUserId)?.name || "" : "";
      const when = c.timestamp ? toReviztoTimestamp(c.timestamp) : "";
      const move =
        c.statusBefore && c.statusAfter
          ? `${humanise(c.statusBefore)} → ${humanise(c.statusAfter)}`
          : humanise(c.statusAfter ?? c.event);
      const note = (c.comment ?? "").trim();
      return [when, who, move].filter(Boolean).join(" · ") + (note ? `\n    ${note}` : "");
    });
  return `Visibuild status history\n\n${lines.join("\n")}`;
}
