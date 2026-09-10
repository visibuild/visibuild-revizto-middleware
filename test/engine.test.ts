import { describe, expect, it } from "vitest";
import { defaultFilters, defaultMapping, loadConfig, normalizeMapping } from "../src/config";
import type { Env } from "../src/env";
import { isEligible, issueUuidForVisi } from "../src/sync/engine";
import type { Visi } from "../src/visibuild/types";

function visi(overrides: Partial<Visi> = {}): Visi {
  return {
    id: "3f1a2b4c-5d6e-4f70-8901-2233445566aa",
    isRoot: true,
    alias: "VIS-1",
    title: "A visi",
    description: "",
    type: "defect",
    subtypeId: null,
    category: "issue",
    status: "open",
    projectId: "p1",
    locationId: "l1",
    defectRoundId: null,
    projectMilestoneId: null,
    assigneeId: null,
    assigneeType: null,
    createdByProjectUserId: null,
    replacedByVisiId: null,
    projectAttachmentIds: [],
    dueDate: null,
    holdPointSkippedAt: null,
    startedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    archived: false,
    ...overrides,
  };
}

describe("issueUuidForVisi", () => {
  it("reuses the visi's own id when it is a valid v4 UUID", () => {
    expect(issueUuidForVisi("3F1A2B4C-5D6E-4F70-8901-2233445566AA")).toBe("3f1a2b4c-5d6e-4f70-8901-2233445566aa");
  });

  it("generates a fresh UUID for an id Revizto would reject", () => {
    const generated = issueUuidForVisi("not-a-uuid");
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("isEligible", () => {
  const filters = defaultFilters();

  it("accepts an ordinary root visi", () => {
    expect(isEligible(visi(), filters).ok).toBe(true);
  });

  it("excludes archived visis by default", () => {
    const result = isEligible(visi({ archived: true }), filters);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/archived/i);
  });

  it("includes archived visis when asked", () => {
    expect(isEligible(visi({ archived: true }), { ...filters, includeArchived: true }).ok).toBe(true);
  });

  it("excludes a child visi while root-only is on", () => {
    expect(isEligible(visi({ isRoot: false }), filters).ok).toBe(false);
    expect(isEligible(visi({ isRoot: false }), { ...filters, rootOnly: false }).ok).toBe(true);
  });

  it("filters by category, type and status when those lists are set", () => {
    expect(isEligible(visi(), { ...filters, categories: ["ncr"] }).ok).toBe(false);
    expect(isEligible(visi(), { ...filters, categories: ["issue"] }).ok).toBe(true);
    expect(isEligible(visi(), { ...filters, types: ["inspection"] }).ok).toBe(false);
    expect(isEligible(visi(), { ...filters, statuses: ["closed"] }).ok).toBe(false);
    expect(isEligible(visi(), { ...filters, statuses: ["open"] }).ok).toBe(true);
  });

  it("treats an empty list as no restriction", () => {
    expect(isEligible(visi({ category: "anything" }), filters).ok).toBe(true);
  });
});

describe("mapping normalisation", () => {
  it("falls back to defaults for a missing or malformed document", () => {
    expect(normalizeMapping(null)).toEqual(defaultMapping());
    expect(normalizeMapping("nonsense")).toEqual(defaultMapping());
  });

  it("drops an unknown Revizto location field", () => {
    const m = normalizeMapping({ locationDepths: { "1": "level", "2": "elevation" } });
    expect(m.locationDepths).toEqual({ "1": "level", "2": "" });
  });

  it("drops an unknown priority rather than sending it to Revizto", () => {
    const m = normalizeMapping({ priorityRules: { "category:issue": "catastrophic" }, defaultPriority: "nope" });
    expect(m.priorityRules).toEqual({});
    expect(m.defaultPriority).toBe("none");
  });

  it("lower-cases the fallback email addresses", () => {
    const m = normalizeMapping({ defaultAssignee: " Jo@Sub.Example " });
    expect(m.defaultAssignee).toBe("jo@sub.example");
  });

  it("keeps a per-pair scope override, and null when there is none", () => {
    expect(normalizeMapping({ filters: null }).filters).toBeNull();
    expect(normalizeMapping({ filters: { categories: ["ncr", "bogus"] } }).filters?.categories).toEqual(["ncr"]);
  });

  it("only keeps location overrides that actually carry a value", () => {
    const m = normalizeMapping({
      locationOverrides: { l1: { room: "314", zone: "  " }, l2: { nonsense: "x" } },
    });
    expect(m.locationOverrides).toEqual({ l1: { room: "314" } });
  });
});

describe("config loading", () => {
  const env = { DEFAULT_VISIBUILD_API_URL: "https://app.apac.visibuild.com/api/core/v1" } as Env;

  function envWith(stored: unknown): Env {
    return { ...env, CONFIG: { async get() { return JSON.stringify(stored); } } } as unknown as Env;
  }

  it("carries the Visibuild credentials over from the tickets portal's config", async () => {
    const cfg = await loadConfig(
      envWith({
        apiUrl: "https://app.eu.visibuild.com/api/core/v1",
        oauthClientId: "old-id",
        oauthClientSecret: "old-secret",
        brandLabel: "Riverside",
      }),
    );
    expect(cfg.visibuildApiUrl).toBe("https://app.eu.visibuild.com/api/core/v1");
    expect(cfg.visibuildClientId).toBe("old-id");
    expect(cfg.visibuildClientSecret).toBe("old-secret");
    expect(cfg.brandLabel).toBe("Riverside");
  });

  it("drops keys it does not recognise, rather than carrying them forever", async () => {
    const cfg = await loadConfig(envWith({ ticketColumns: [{ key: "ticketNo" }], exposedProjectIds: ["p1"] }));
    expect(cfg).not.toHaveProperty("ticketColumns");
    expect(cfg).not.toHaveProperty("exposedProjectIds");
  });

  it("falls back to defaults for an unreadable document", async () => {
    const broken = { ...env, CONFIG: { async get() { return "{not json"; } } } as unknown as Env;
    await expect(loadConfig(broken)).resolves.toMatchObject({ reviztoRegion: "sydney" });
  });
});
