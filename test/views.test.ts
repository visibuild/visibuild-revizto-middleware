import { describe, expect, it } from "vitest";
import { defaultConfig, defaultMapping } from "../src/config";
import type { Env } from "../src/env";
import type { ProjectPair, SyncEvent, SyncRun } from "../src/db";
import { dashboardPage } from "../src/views/dashboard";
import { esc, sanitizeHexColor, sanitizeLogoUrl, visiStatusBadge, type Theme } from "../src/views/layout";
import { adminLoginPage, viewerLoginPage } from "../src/views/login";
import { mappingPage } from "../src/views/mapping";
import { pairsPage } from "../src/views/pairs";
import { runDetailPage, runsPage } from "../src/views/runs";
import { SETTINGS_SECTIONS, SHOW_WEBHOOKS, settingsPage, webhookSection } from "../src/views/settings";

const theme: Theme = { brandLabel: "Riverside sync", logoUrl: "", faviconUrl: "", primaryColor: "#5c7e6a" };
const cfg = defaultConfig({ DEFAULT_VISIBUILD_API_URL: "https://app.apac.visibuild.com/api/core/v1" } as Env);

const pair: ProjectPair = {
  id: "pair-1",
  visibuildProjectId: "p1",
  visibuildProjectName: "Riverside <Stage 2>",
  reviztoRegion: "sydney",
  reviztoLicenseUuid: "lic-1",
  reviztoProjectUuid: "rp-uuid",
  reviztoProjectId: 21,
  reviztoProjectName: "Riverside Coordination",
  enabled: true,
  visiCursor: "2026-01-06T04:00:00Z",
  reviztoCursor: "2026-01-06 04:00:00",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-06T04:00:00Z",
};

const run: SyncRun = {
  id: "run-1",
  trigger: "cron",
  status: "partial",
  startedAt: "2026-01-06T05:00:00Z",
  finishedAt: "2026-01-06T05:00:20Z",
  created: 3,
  updated: 2,
  skipped: 10,
  conflicts: 1,
  failed: 1,
  message: "Stopped at the per-run cap",
};

describe("sanitisers", () => {
  it("only accepts a six-digit hex colour", () => {
    expect(sanitizeHexColor("#ABCDEF", "#000000")).toBe("#abcdef");
    expect(sanitizeHexColor("red", "#000000")).toBe("#000000");
    expect(sanitizeHexColor("javascript:alert(1)", "#000000")).toBe("#000000");
  });

  it("only accepts http(s) image URLs", () => {
    expect(sanitizeLogoUrl("https://example.com/logo.png")).toBe("https://example.com/logo.png");
    expect(sanitizeLogoUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeLogoUrl("data:image/png;base64,AAAA")).toBe("");
  });

  it("escapes every character that could break out of markup", () => {
    expect(esc(`<script>"'&`)).toBe("&lt;script&gt;&quot;&#39;&amp;");
  });
});

describe("dashboard", () => {
  const base = {
    theme,
    role: "admin" as const,
    schemaReady: true,
    visibuildConnected: true,
    reviztoConfigured: true,
    reviztoTokens: {
      region: "sydney",
      accessToken: "t",
      accessTokenExpiresAt: 0,
      refreshToken: "r",
      connectedEmail: "sync@example.com",
      connectedName: "Sync Bot",
      connectedAt: "2026-01-01T00:00:00Z",
    },
    pairs: [{ pair, linked: 42, errored: 2 }],
    lastRun: run,
  };

  it("shows who the sync acts as in Revizto", () => {
    const html = dashboardPage(base);
    expect(html).toContain("Sync Bot");
    expect(html).toContain("Australia");
  });

  it("escapes project names", () => {
    expect(dashboardPage(base)).toContain("Riverside &lt;Stage 2&gt;");
    expect(dashboardPage(base)).not.toContain("<Stage 2>");
  });

  it("nags when the database schema has not been applied", () => {
    expect(dashboardPage({ ...base, schemaReady: false })).toContain("db:migrate");
  });

  it("prompts to reconnect when the Revizto authorisation has lapsed", () => {
    const html = dashboardPage({
      ...base,
      reviztoTokens: { ...base.reviztoTokens, needsReauth: true, lastError: "Refresh token expired" },
    });
    expect(html).toContain("Reconnect needed");
    expect(html).toContain("Refresh token expired");
  });

  it("offers a first step when nothing is paired yet", () => {
    const html = dashboardPage({ ...base, pairs: [], lastRun: null });
    expect(html).toContain("No projects are being synced");
    expect(html).toContain("/pairs");
  });

  it("hides the sync button from a viewer", () => {
    expect(dashboardPage({ ...base, role: "viewer" })).not.toContain("Sync now");
  });
});

describe("pairs page", () => {
  const base = {
    theme,
    role: "admin" as const,
    pairs: [pair],
    visibuildProjects: [
      { id: "p1", name: "Riverside", projectIdentifier: "RS2", rootLocationId: "l0", address: null, active: true },
    ],
    licenses: [{ uuid: "lic-1", name: "Acme licence", accountUuid: null }],
    selectedLicense: "lic-1",
    reviztoProjects: [{ id: 21, uuid: "rp-uuid", title: "Riverside Coordination", archived: false }],
  };

  it("carries the Revizto uuid, integer id and title in one option value", () => {
    // The pair needs all three, and this is the only place they are together.
    expect(pairsPage(base)).toContain('value="rp-uuid|21|Riverside Coordination"');
  });

  it("leaves out archived Revizto projects", () => {
    const html = pairsPage({
      ...base,
      reviztoProjects: [{ id: 22, uuid: "old", title: "Archived project", archived: true }],
    });
    expect(html).not.toContain("Archived project");
  });

  it("explains what to do when Revizto is not connected", () => {
    const html = pairsPage({ ...base, licenses: null, reviztoProjects: null });
    expect(html).toContain("Connect Revizto in Settings");
  });

  it("does not show the create form to a viewer", () => {
    expect(pairsPage({ ...base, role: "viewer" })).not.toContain("Create pair");
  });
});

describe("mapping page", () => {
  const base = {
    theme,
    role: "admin" as const,
    pair,
    mapping: defaultMapping(),
    linked: 42,
    errored: 0,
    reviztoStatuses: [{ uuid: "s1", name: "Open", category: "To do", deleted: false }],
    reviztoTypes: [{ uuid: "t1", name: "Standard issue", isDefault: true, isActive: true, deleted: false, workflowUuid: "w1" }],
    reviztoMembers: [{ email: "jo@sub.example", fullname: "Jo Chen", uuid: "u1", company: "Sub Co", frozen: false }],
    visibuildUsers: [
      { id: "pu1", name: "Jo Chen", email: "jo@sub.example", companyName: "Sub Co" },
      { id: "pu2", name: "Sam Rivers", email: "sam@builder.example", companyName: "Builder Co" },
    ],
    visibuildCompanies: [{ id: "pc1", name: "Sub Co" }],
    locations: [
      { id: "l1", name: "North Tower", depth: 1, path: ["Riverside", "North Tower"], parentId: "root" },
      { id: "l2", name: "Level 3", depth: 2, path: ["Riverside", "North Tower", "Level 3"], parentId: "l1" },
    ],
    subtypes: [{ id: "st1", name: "Waterproofing", visiCategory: "issue" }],
    visiTypes: ["defect", "inspection"],
  };

  it("renders a row per visi status, mapping into the Revizto statuses", () => {
    const html = mappingPage(base);
    expect(html).toContain('name="status:open"');
    expect(html).toContain('name="status:cant_close"');
    expect(html).toContain("Open (To do)");
  });

  it("namespaces type rules by subtype, type and category", () => {
    const html = mappingPage(base);
    expect(html).toContain('name="type:subtype:st1"');
    expect(html).toContain('name="type:type:defect"');
    expect(html).toContain('name="type:category:issue"');
  });

  it("tells the operator which people already match by email", () => {
    const html = mappingPage(base);
    expect(html).toContain("Matched by email (jo@sub.example)");
    // Sam has no Revizto member with that address.
    expect(html).toContain("1 person has");
  });

  it("warns that Revizto location tags cannot be changed after creation", () => {
    expect(mappingPage(base)).toContain("only accepts location tags when an issue is first created");
  });

  it("offers a per-location override for each location", () => {
    const html = mappingPage(base);
    expect(html).toContain('name="loc:l2:room"');
    expect(html).toContain("North Tower / Level 3");
  });

  it("shows the mapping read-only to a viewer", () => {
    const html = mappingPage({ ...base, role: "viewer" });
    expect(html).toContain("Sign in as an admin");
    expect(html).not.toContain('name="status:open"');
  });
});

describe("sync log", () => {
  it("lists runs with their outcome", () => {
    const html = runsPage({ theme, role: "viewer", runs: [run] });
    expect(html).toContain("Partial");
    expect(html).toContain("/runs/run-1");
  });

  it("spells out exactly what a conflict overwrote", () => {
    const events: SyncEvent[] = [
      {
        id: 1,
        runId: "run-1",
        pairId: "pair-1",
        visiId: "v1",
        visiAlias: "VIS-42",
        action: "conflict",
        detail: {
          changed: ["customStatus"],
          diff: { customStatus: { old: "reviztos-value", new: "ours" } },
          overwritten: [{ field: "customStatus", ours: "shadow-value", theirs: "reviztos-value" }],
        },
        createdAt: "2026-01-06T05:00:10Z",
      },
    ];
    const html = runDetailPage({
      theme,
      role: "viewer",
      run,
      events,
      pairNames: new Map([["pair-1", "Riverside"]]),
      truncated: false,
    });
    expect(html).toContain("Overwrote a manual change in Revizto");
    expect(html).toContain("reviztos-value");
    expect(html).toContain("shadow-value");
    expect(html).toContain("Status");
  });

  it("shows why a visi was skipped", () => {
    const events: SyncEvent[] = [
      {
        id: 1,
        runId: "run-1",
        pairId: null,
        visiId: "v1",
        visiAlias: null,
        action: "skip",
        detail: { reason: "Visi is archived." },
        createdAt: "2026-01-06T05:00:10Z",
      },
    ];
    const html = runDetailPage({ theme, role: "viewer", run, events, pairNames: new Map(), truncated: false });
    expect(html).toContain("Visi is archived.");
    expect(html).toContain("No change");
  });
});

describe("settings page", () => {
  const base = {
    theme,
    cfg,
    hasVisibuildSecret: true,
    hasReviztoSecret: false,
    hasViewerPassword: false,
    tokens: null,
    redirectUri: "https://sync.example.com/settings/revizto/callback",
    webhooks: [],
  };

  it("shows the exact redirect URI to register with Revizto", () => {
    expect(settingsPage(base)).toContain("https://sync.example.com/settings/revizto/callback");
  });

  it("keeps a saved secret masked rather than rendering it", () => {
    const html = settingsPage({ ...base, cfg: { ...cfg, visibuildClientSecret: "super-secret" } });
    expect(html).not.toContain("super-secret");
    expect(html).toContain("leave blank to keep");
  });

  it("explains that Revizto has no machine-to-machine flow", () => {
    expect(settingsPage(base)).toContain("no machine-to-machine flow");
  });

  it("keeps the webhook section hidden while there is no event to consume", () => {
    expect(SHOW_WEBHOOKS).toBe(false);
    const html = settingsPage({ ...base, newWebhookSecret: "whsec_abc123" });
    expect(html).not.toContain("Webhooks");
    expect(html).not.toContain("whsec_abc123");
  });

  it("still has the webhook section ready for when the flag flips", () => {
    // Built and tested, just not rendered – see SHOW_WEBHOOKS.
    const section = webhookSection({ ...base, newWebhookSecret: "whsec_abc123" });
    expect(section).toContain("whsec_abc123");
    expect(section).toContain("shown once");
    expect(section).toContain("/settings/webhooks");
  });

  it("gives every section its own form, so one can be saved without the others", () => {
    const html = settingsPage(base);
    for (const section of SETTINGS_SECTIONS) {
      expect(html).toContain(`<input type="hidden" name="section" value="${section}">`);
    }
    // One form per section, plus the logout form. With no tokens there is no
    // Disconnect form, and the webhook section is hidden.
    expect(html.match(/<form /g) ?? []).toHaveLength(SETTINGS_SECTIONS.length + 1);
  });

  it("keeps the Visibuild and Revizto fields in separate forms", () => {
    const html = settingsPage(base);
    const forms = html.split("<form ").slice(1).map((f) => f.split("</form>")[0]);
    const visibuild = forms.find((f) => f.includes('value="visibuild"'))!;
    const revizto = forms.find((f) => f.includes('value="revizto"'))!;
    expect(visibuild).toContain('name="visibuildClientId"');
    expect(visibuild).not.toContain('name="reviztoClientId"');
    expect(revizto).toContain('name="reviztoClientId"');
    expect(revizto).not.toContain('name="visibuildClientId"');
  });

  it("keeps the Disconnect form out of the credentials form, since forms cannot nest", () => {
    const html = settingsPage({
      ...base,
      tokens: {
        region: "sydney",
        accessToken: "t",
        accessTokenExpiresAt: 0,
        refreshToken: "r",
        connectedEmail: "sync@example.com",
        connectedName: "Sync Bot",
        connectedAt: "2026-01-01T00:00:00Z",
      },
    });
    const reviztoForm = html
      .split('<input type="hidden" name="section" value="revizto">')[1]
      .split("</form>")[0];
    expect(reviztoForm).not.toContain("/settings/revizto/disconnect");
    expect(html).toContain("/settings/revizto/disconnect");
  });

  it("puts a save confirmation inside the card it refers to", () => {
    const html = settingsPage({
      ...base,
      message: { kind: "success", text: "Saved." },
      messageSection: "branding",
    });
    // Rendered before the heading, the banner sits between the previous card
    // and the branding title, reading as though the previous section saved.
    const brandingHeading = '<p class="form-section-title" id="branding">';
    expect(html.indexOf("Saved.")).toBeGreaterThan(html.indexOf(brandingHeading));
    // ...and inside branding's own card, not adrift after it.
    const card = html.split(brandingHeading)[1].split("</form>")[0];
    expect(card).toContain("Saved.");
    expect(html.match(/Saved\./g) ?? []).toHaveLength(1);
  });

  it("gives each section an id to anchor the post-save redirect to", () => {
    const html = settingsPage(base);
    for (const section of SETTINGS_SECTIONS) {
      expect(html).toContain(`<p class="form-section-title" id="${section}">`);
    }
  });
});

describe("visi vocabulary", () => {
  it("renders NCR and N/A correctly wherever a status or category is listed", () => {
    const html = settingsPage({
      theme,
      cfg,
      hasVisibuildSecret: false,
      hasReviztoSecret: false,
      hasViewerPassword: false,
      tokens: null,
      redirectUri: "https://sync.example.com/settings/revizto/callback",
      webhooks: [],
    });
    expect(html).toContain(">NCR<");
    expect(html).toContain(">N/A<");
    expect(html).not.toContain(">Ncr<");
    expect(html).not.toContain(">N A<");
  });

  it("uses the same wording on a status badge", () => {
    expect(visiStatusBadge("ncr")).toContain(">NCR<");
    expect(visiStatusBadge("n_a")).toContain(">N/A<");
  });
});

describe("login pages", () => {
  it("does not repeat the brand label in the viewer gate's tab title", () => {
    const html = viewerLoginPage(theme);
    expect(html).toContain("<title>Riverside sync</title>");
  });

  it("still qualifies the admin gate's title", () => {
    expect(adminLoginPage(theme)).toContain("<title>Admin sign in · Riverside sync</title>");
  });
});
