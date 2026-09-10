import { describe, expect, it } from "vitest";
import { defaultMapping, type PairMapping } from "../src/config";
import {
  buildDiff,
  dateToReviztoTimestamp,
  detectConflicts,
  locationPath,
  mapVisi,
  renderRequirements,
  renderStatusChanges,
  renderTitle,
  resolveAssignee,
  resolveLocation,
  resolveReporter,
  resolveTags,
  toReviztoTimestamp,
  type MappingContext,
} from "../src/sync/mapping";
import { buildLocationTree } from "../src/visibuild/resolve";
import type { Visi } from "../src/visibuild/types";

// A three-level location tree: Project > North Tower > Level 3 > Apartment 314.
const locations = [
  { id: "root", name: "Riverside" },
  { id: "tower", name: "North Tower" },
  { id: "level", name: "Level 3" },
  { id: "apt", name: "Apartment 314" },
];
const closures = [
  { ancestorId: "root", descendantId: "root", depth: 0 },
  { ancestorId: "root", descendantId: "tower", depth: 1 },
  { ancestorId: "tower", descendantId: "tower", depth: 0 },
  { ancestorId: "root", descendantId: "level", depth: 2 },
  { ancestorId: "tower", descendantId: "level", depth: 1 },
  { ancestorId: "level", descendantId: "level", depth: 0 },
  { ancestorId: "root", descendantId: "apt", depth: 3 },
  { ancestorId: "tower", descendantId: "apt", depth: 2 },
  { ancestorId: "level", descendantId: "apt", depth: 1 },
  { ancestorId: "apt", descendantId: "apt", depth: 0 },
];

const ctx: MappingContext = {
  locations: buildLocationTree(locations, closures),
  projectUsers: new Map([
    ["pu-1", { email: "sam@builder.example", name: "Sam Rivers", companyName: "Builder Co" }],
    ["pu-2", { email: "jo@sub.example", name: "Jo Chen", companyName: "Sub Co" }],
    ["pu-3", { email: "", name: "No Email", companyName: "Sub Co" }],
  ]),
  projectCompanies: new Map([["pc-1", "Sub Co"]]),
  subtypeNames: new Map([["st-1", "Waterproofing"]]),
  milestoneNames: new Map([["pm-1", "Practical completion"]]),
  defectRoundNames: new Map([["dr-1", "Round 2"]]),
  visiTagNames: new Map([["v-1", ["Urgent", "Wet area"]]]),
};

function visi(overrides: Partial<Visi> = {}): Visi {
  return {
    id: "v-1",
    isRoot: true,
    alias: "VIS-42",
    title: "Cracked tile at entry",
    description: "The tile by the entry door is cracked.",
    type: "defect",
    subtypeId: "st-1",
    category: "issue",
    status: "open",
    projectId: "p-1",
    locationId: "apt",
    defectRoundId: "dr-1",
    projectMilestoneId: "pm-1",
    assigneeId: "pu-2",
    assigneeType: "ProjectUser",
    createdByProjectUserId: "pu-1",
    replacedByVisiId: null,
    projectAttachmentIds: [],
    dueDate: "2026-02-01",
    holdPointSkippedAt: null,
    startedAt: null,
    createdAt: "2026-01-05T02:30:00Z",
    updatedAt: "2026-01-06T04:00:00Z",
    archived: false,
    ...overrides,
  };
}

function mapping(overrides: Partial<PairMapping> = {}): PairMapping {
  return {
    ...defaultMapping(),
    statuses: { open: "status-open-uuid", closed: "status-closed-uuid" },
    defaultStatus: "status-open-uuid",
    types: { "category:issue": "type-issue-uuid", "subtype:st-1": "type-waterproofing-uuid" },
    defaultType: "type-default-uuid",
    ...overrides,
  };
}

describe("timestamps", () => {
  it("converts ISO to Revizto's format", () => {
    expect(toReviztoTimestamp("2026-01-05T02:30:00Z")).toBe("2026-01-05 02:30:00");
  });

  it("returns an empty string rather than a bogus date", () => {
    expect(toReviztoTimestamp(null)).toBe("");
    expect(toReviztoTimestamp("not a date")).toBe("");
  });

  it("gives a date-only due date a midnight time", () => {
    expect(dateToReviztoTimestamp("2026-02-01")).toBe("2026-02-01 00:00:00");
  });
});

describe("location tree", () => {
  it("reconstructs each location's depth and path from the closure table", () => {
    const tree = buildLocationTree(locations, closures);
    expect(tree.get("apt")!.depth).toBe(3);
    expect(tree.get("apt")!.path).toEqual(["Riverside", "North Tower", "Level 3", "Apartment 314"]);
    expect(tree.get("tower")!.parentId).toBe("root");
  });

  it("drops the project root from the readable path", () => {
    expect(locationPath(visi(), ctx)).toBe("North Tower / Level 3 / Apartment 314");
  });

  it("maps each depth onto the configured Revizto location field", () => {
    const result = resolveLocation(visi(), mapping(), ctx);
    // Default depths are 1 -> area, 2 -> level, 3 -> room.
    expect(result).toEqual({
      area: "North Tower",
      level: "Level 3",
      room: "Apartment 314",
      zone: null,
      space: null,
    });
  });

  it("lets a per-location override replace the depth rules outright", () => {
    const result = resolveLocation(
      visi(),
      mapping({ locationOverrides: { apt: { zone: "Wet areas", room: "314" } } }),
      ctx,
    );
    expect(result).toEqual({ zone: "Wet areas", room: "314", area: null, level: null, space: null });
  });

  it("returns empty tags for a visi with no location", () => {
    expect(resolveLocation(visi({ locationId: null }), mapping(), ctx)).toEqual({
      level: null,
      room: null,
      area: null,
      zone: null,
      space: null,
    });
  });
});

describe("assignee and reporter", () => {
  it("prefers an explicit mapping", () => {
    const m = mapping({ users: { "pu-2": "mapped@revizto.example" } });
    expect(resolveAssignee(visi(), m, ctx)).toEqual({ email: "mapped@revizto.example", source: "user mapping" });
  });

  it("falls back to matching the Visibuild user's own email", () => {
    expect(resolveAssignee(visi(), mapping(), ctx)).toEqual({ email: "jo@sub.example", source: "matched by email" });
  });

  it("resolves a company-assigned visi through the company map", () => {
    const v = visi({ assigneeId: "pc-1", assigneeType: "ProjectCompany" });
    const m = mapping({ companies: { "pc-1": "lead@sub.example" } });
    expect(resolveAssignee(v, m, ctx)).toEqual({ email: "lead@sub.example", source: "company mapping" });
  });

  it("falls back to the default when a company has no mapping", () => {
    const v = visi({ assigneeId: "pc-1", assigneeType: "ProjectCompany" });
    const m = mapping({ defaultAssignee: "fallback@revizto.example" });
    expect(resolveAssignee(v, m, ctx)).toEqual({ email: "fallback@revizto.example", source: "default assignee" });
  });

  it("reports no assignee rather than inventing one", () => {
    const v = visi({ assigneeId: "pu-3" }); // a project user with no email on file
    expect(resolveAssignee(v, mapping(), ctx)).toEqual({ email: "", source: "unresolved" });
  });

  it("resolves the reporter from the visi's creator", () => {
    expect(resolveReporter(visi(), mapping(), ctx)).toEqual({ email: "sam@builder.example", source: "matched by email" });
  });
});

describe("title", () => {
  it("substitutes the template placeholders", () => {
    expect(renderTitle(visi(), mapping(), ctx)).toBe("VIS-42 Cracked tile at entry");
  });

  it("does not leave a gap when the alias is missing", () => {
    expect(renderTitle(visi({ alias: null }), mapping(), ctx)).toBe("Cracked tile at entry");
  });

  it("supports a location placeholder", () => {
    const m = mapping({ titleTemplate: "{location}: {title}" });
    expect(renderTitle(visi(), m, ctx)).toBe("North Tower / Level 3 / Apartment 314: Cracked tile at entry");
  });

  it("truncates at Revizto's 255-character ceiling", () => {
    const long = renderTitle(visi({ alias: null, title: "x".repeat(400) }), mapping(), ctx);
    expect(long).toHaveLength(255);
  });

  it("never produces an empty title", () => {
    const m = mapping({ titleTemplate: "{alias}" });
    expect(renderTitle(visi({ alias: null }), m, ctx)).toBe("Cracked tile at entry");
  });
});

describe("tags", () => {
  it("combines the visi's own tags with the derived ones, sorted", () => {
    expect(resolveTags(visi(), mapping(), ctx)).toEqual([
      "Defect",
      "North Tower / Level 3 / Apartment 314",
      "Urgent",
      "Waterproofing",
      "Wet area",
    ]);
  });

  it("honours the prefix", () => {
    const m = mapping({ tagPrefix: "vb:", derivedTags: { ...defaultMapping().derivedTags, location: false, subtype: false } });
    expect(resolveTags(visi(), m, ctx)).toEqual(["vb:Defect", "vb:Urgent", "vb:Wet area"]);
  });

  it("drops the visi's own tags when passthrough is off", () => {
    const m = mapping({ tagPassthrough: false });
    expect(resolveTags(visi(), m, ctx)).not.toContain("Urgent");
  });
});

describe("mapVisi", () => {
  it("maps the whole field set", () => {
    const result = mapVisi(visi(), mapping(), ctx);
    expect(result.fields).toMatchObject({
      title: "VIS-42 Cracked tile at entry",
      customStatus: "status-open-uuid",
      // The subtype rule is more specific than the category rule, so it wins.
      customType: "type-waterproofing-uuid",
      assignee: "jo@sub.example",
      reporter: "sam@builder.example",
      deadline: "2026-02-01 00:00:00",
      priority: "none",
      visibility: 1,
    });
    expect(result.created).toBe("2026-01-05 02:30:00");
    expect(result.warnings).toHaveLength(0);
  });

  it("falls back from subtype to type to category", () => {
    const m = mapping({ types: { "category:issue": "cat-uuid", "type:defect": "type-uuid" } });
    expect(mapVisi(visi(), m, ctx).fields.customType).toBe("type-uuid");
    expect(mapVisi(visi({ type: "task" }), m, ctx).fields.customType).toBe("cat-uuid");
  });

  it("warns when a status has no mapping and the default is used", () => {
    const result = mapVisi(visi({ status: "cant_close" }), mapping(), ctx);
    expect(result.fields.customStatus).toBe("status-open-uuid");
    expect(result.warnings.join(" ")).toContain("cant_close");
  });

  it("warns when nothing resolves a status at all", () => {
    const m = mapping({ statuses: {}, defaultStatus: "" });
    expect(mapVisi(visi(), m, ctx).warnings.join(" ")).toContain("No Revizto status");
  });

  it("applies a priority rule by category", () => {
    const m = mapping({ priorityRules: { "category:issue": "major" } });
    expect(mapVisi(visi(), m, ctx).fields.priority).toBe("major");
  });

  it("leaves the deadline blank when the visi has no due date", () => {
    expect(mapVisi(visi({ dueDate: null }), mapping(), ctx).fields.deadline).toBe("");
  });
});

describe("buildDiff", () => {
  const desired = mapVisi(visi(), mapping(), ctx).fields;

  it("produces nothing when the current state already matches", () => {
    const { diff, changed } = buildDiff(desired, desired);
    expect(changed).toEqual([]);
    expect(diff).toEqual({});
  });

  it("emits an old/new pair for each changed field", () => {
    const { diff, changed } = buildDiff({ ...desired, title: "Old title", priority: "minor" }, desired);
    expect(changed.sort()).toEqual(["priority", "title"]);
    expect(diff.title).toEqual({ old: "Old title", new: "VIS-42 Cracked tile at entry" });
  });

  it("skips a field whose current value is unknown, rather than guessing", () => {
    // A wrong `old` makes Revizto drop the change silently, so not writing is safer.
    const { changed } = buildDiff({ title: "Old title" }, desired);
    expect(changed).toEqual(["title"]);
  });

  it("compares tags by content, not identity", () => {
    const current = { ...desired, tags: [...desired.tags] };
    expect(buildDiff(current, desired).changed).toEqual([]);
  });

  it("never writes an empty status or type over a real one", () => {
    const blank = { ...desired, customStatus: "", customType: "" };
    const { changed } = buildDiff(desired, blank);
    expect(changed).not.toContain("customStatus");
    expect(changed).not.toContain("customType");
  });
});

describe("detectConflicts", () => {
  it("reports fields Revizto holds differently from what we last wrote", () => {
    const shadow = { title: "Ours", priority: "none" as const };
    const live = { title: "Edited in Revizto", priority: "none" as const };
    expect(detectConflicts(shadow, live)).toEqual([
      { field: "title", ours: "Ours", theirs: "Edited in Revizto" },
    ]);
  });

  it("ignores fields Revizto did not report", () => {
    expect(detectConflicts({ title: "Ours" }, {})).toEqual([]);
  });
});

describe("comment bodies", () => {
  it("renders checklist answers in order", () => {
    const body = renderRequirements([
      { id: "r2", visiId: "v-1", type: "checkbox", order: 2, title: "Sealed", value: "true", choices: null, allowMultiple: false, values: null, updatedAt: null },
      { id: "r1", visiId: "v-1", type: "short_answer", order: 1, title: "Notes", value: "Looks fine", choices: null, allowMultiple: false, values: null, updatedAt: null },
    ]);
    expect(body).toContain("Notes: Looks fine");
    expect(body).toContain("Sealed: Yes");
    expect(body.indexOf("Notes")).toBeLessThan(body.indexOf("Sealed"));
  });

  it("renders a status history oldest first, with the user's name", () => {
    const body = renderStatusChanges(
      [
        { id: "c1", visiId: "v-1", projectUserId: "pu-1", event: "closed", comment: "Fixed", statusBefore: "open", statusAfter: "closed", timestamp: "2026-01-06T04:00:00Z" },
        { id: "c0", visiId: "v-1", projectUserId: "pu-2", event: "opened", comment: null, statusBefore: null, statusAfter: "open", timestamp: "2026-01-05T02:30:00Z" },
      ],
      ctx,
    );
    expect(body.indexOf("Jo Chen")).toBeLessThan(body.indexOf("Sam Rivers"));
    expect(body).toContain("Open → Closed");
    expect(body).toContain("Fixed");
  });

  it("returns nothing for an empty history", () => {
    expect(renderStatusChanges([], ctx)).toBe("");
  });
});
