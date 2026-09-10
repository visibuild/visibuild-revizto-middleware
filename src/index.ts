/**
 * index.ts – Cloudflare Worker entry point.
 *
 * A small Hono app that renders server-side HTML, plus a `scheduled` handler
 * that runs the sync hourly. Pages are gated by an HMAC-signed session cookie
 * (see auth.ts). There is no user table – an admin password set as a Worker
 * secret, and an optional read-only viewer password set in Settings.
 *
 * All third-party credentials live in KV, entered through Settings, so a
 * redeploy never needs them and rotating one is a page load rather than a
 * deploy.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  safeEqual,
  verifySessionToken,
  type Role,
  type Session,
} from "./auth";
import {
  DEFAULT_BRAND,
  DEFAULT_PRIMARY,
  defaultMapping,
  hasReviztoCredentials,
  hasVisibuildCredentials,
  loadConfig,
  loadMapping,
  normalizeMapping,
  reviztoConnection,
  saveConfig,
  saveMapping,
  deleteMapping,
  visibuildCredentials,
  type AppConfig,
  type PairMapping,
  type SyncFilters,
} from "./config";
import * as db from "./db";
import type { Env } from "./env";
import * as revizto from "./revizto/client";
import * as oauth from "./revizto/oauth";
import { REVIZTO_REGIONS, type ReviztoLicense, type ReviztoProject } from "./revizto/types";
import { runSync } from "./sync/engine";
import * as vb from "./visibuild/client";
import { loadProjectContext, resetContextCache } from "./visibuild/resolve";
import * as webhooks from "./visibuild/webhooks";
import { VISI_CATEGORIES, VISI_STATUSES, VISI_TYPES, type Project, type WebhookEndpoint } from "./visibuild/types";
import type { PageMessage } from "./views/components";
import { dashboardPage, type PairStatus } from "./views/dashboard";
import { esc, layout, sanitizeHexColor, sanitizeLogoUrl, type Theme } from "./views/layout";
import { adminLoginPage, viewerLoginPage } from "./views/login";
import { mappingPage, type MappableCompany, type MappableUser } from "./views/mapping";
import { pairsPage } from "./views/pairs";
import { runDetailPage, runsPage } from "./views/runs";
import { SETTINGS_SECTIONS, SHOW_WEBHOOKS, settingsPage, type SettingsSection } from "./views/settings";

type Variables = { session: Session };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function themeFor(cfg: AppConfig): Theme {
  return {
    brandLabel: cfg.brandLabel || DEFAULT_BRAND,
    logoUrl: sanitizeLogoUrl(cfg.logoUrl),
    faviconUrl: sanitizeLogoUrl(cfg.faviconUrl),
    primaryColor: sanitizeHexColor(cfg.primaryColor, DEFAULT_PRIMARY),
  };
}

async function currentSession(c: { env: Env; req: any }): Promise<Session | null> {
  return verifySessionToken(c.env.SESSION_SECRET, getCookie(c as any, SESSION_COOKIE));
}

async function issueSession(c: any, role: Role): Promise<void> {
  const token = await createSessionToken(c.env.SESSION_SECRET, role);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** A one-shot message carried across a redirect in the query string. */
function flash(kind: PageMessage["kind"], text: string): string {
  return `?msg=${encodeURIComponent(text)}&kind=${kind}`;
}

function readFlash(c: any): PageMessage | undefined {
  const text = c.req.query("msg");
  if (!text) return undefined;
  const kind = c.req.query("kind");
  return { kind: kind === "error" || kind === "info" ? kind : "success", text: String(text) };
}

function errorMessage(e: unknown): string {
  if (e instanceof vb.VisibuildError && e.status === 429) {
    return "Visibuild has temporarily rate-limited this app. Wait about a minute and try again.";
  }
  return (e as Error)?.message || "Something went wrong.";
}

// ---------------------------------------------------------------------------
// Middleware: security headers + auth gates
// ---------------------------------------------------------------------------

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
  // Scripts only from our own origin (no inline scripts – behaviour lives in
  // /app.js). Inline styles are allowed for the injected --primary.
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' https: data:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      // The Revizto authorisation step navigates the browser off-origin.
      "form-action 'self'",
    ].join("; "),
  );
});

const requireViewer = async (c: any, next: any) => {
  const s = await currentSession(c);
  if (!s) return c.redirect("/login");
  c.set("session", s);
  await next();
};

const requireAdmin = async (c: any, next: any) => {
  const s = await currentSession(c);
  if (!s || s.role !== "admin") return c.redirect("/settings/login");
  c.set("session", s);
  await next();
};

// ---------------------------------------------------------------------------
// Health check (unauthenticated)
// ---------------------------------------------------------------------------

app.get("/healthz", (c) => c.text("ok"));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.get("/login", async (c) => {
  if (await currentSession(c)) return c.redirect("/");
  const cfg = await loadConfig(c.env);
  return c.html(viewerLoginPage(themeFor(cfg)));
});

app.post("/login", async (c) => {
  const cfg = await loadConfig(c.env);
  const form = await c.req.formData();
  const pw = String(form.get("password") ?? "");

  let role: Role | null = null;
  if (c.env.ADMIN_PASSWORD && safeEqual(pw, c.env.ADMIN_PASSWORD)) role = "admin";
  else if (cfg.viewerPassword && safeEqual(pw, cfg.viewerPassword)) role = "viewer";

  if (!role) return c.html(viewerLoginPage(themeFor(cfg), "Incorrect password."), 401);
  await issueSession(c, role);
  return c.redirect("/");
});

app.get("/settings/login", async (c) => {
  const s = await currentSession(c);
  if (s?.role === "admin") return c.redirect("/settings");
  const cfg = await loadConfig(c.env);
  return c.html(adminLoginPage(themeFor(cfg)));
});

app.post("/settings/login", async (c) => {
  const cfg = await loadConfig(c.env);
  const form = await c.req.formData();
  const pw = String(form.get("password") ?? "");
  if (!(c.env.ADMIN_PASSWORD && safeEqual(pw, c.env.ADMIN_PASSWORD))) {
    return c.html(adminLoginPage(themeFor(cfg), "Incorrect password."), 401);
  }
  await issueSession(c, "admin");
  return c.redirect("/settings");
});

app.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login");
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

app.get("/", requireViewer, async (c) => {
  const cfg = await loadConfig(c.env);
  const session = c.get("session");

  const ready = await db.schemaReady(c.env);
  const [tokens, pairs, lastRun] = await Promise.all([
    oauth.loadTokens(c.env),
    ready ? db.listPairs(c.env) : Promise.resolve([]),
    ready ? db.latestRun(c.env) : Promise.resolve(null),
  ]);

  const statuses: PairStatus[] = await Promise.all(
    pairs.map(async (pair) => {
      const counts = await db.countLinks(c.env, pair.id);
      return { pair, linked: counts.total, errored: counts.errored };
    }),
  );

  return c.html(
    dashboardPage({
      theme: themeFor(cfg),
      role: session.role,
      message: readFlash(c),
      schemaReady: ready,
      visibuildConnected: hasVisibuildCredentials(cfg),
      reviztoConfigured: hasReviztoCredentials(cfg),
      reviztoTokens: tokens,
      pairs: statuses,
      lastRun,
    }),
  );
});

/** Run the sync now, then land on the run's detail page. */
app.post("/sync", requireAdmin, async (c) => {
  const summary = await runSync(c.env, { trigger: "manual" });
  return c.redirect(`/runs/${summary.runId}`);
});

// ---------------------------------------------------------------------------
// Project pairs
// ---------------------------------------------------------------------------

interface VisibuildProjectsResult {
  projects: Project[] | null;
  error?: string;
}

async function loadVisibuildProjects(cfg: AppConfig): Promise<VisibuildProjectsResult> {
  if (!hasVisibuildCredentials(cfg)) return { projects: null };
  try {
    return { projects: await vb.listProjects(visibuildCredentials(cfg)) };
  } catch (e) {
    return { projects: null, error: `Couldn't load Visibuild projects: ${errorMessage(e)}` };
  }
}

interface ReviztoLicensesResult {
  licenses: ReviztoLicense[] | null;
  error?: string;
}

async function loadReviztoLicenses(env: Env, cfg: AppConfig): Promise<ReviztoLicensesResult> {
  if (!hasReviztoCredentials(cfg)) return { licenses: null };
  try {
    return { licenses: await revizto.listLicenses(env, reviztoConnection(cfg)) };
  } catch (e) {
    return { licenses: null, error: `Couldn't load Revizto licences: ${errorMessage(e)}` };
  }
}

app.get("/pairs", requireViewer, async (c) => {
  const cfg = await loadConfig(c.env);
  const session = c.get("session");
  const selectedLicense = c.req.query("license") ?? "";

  const [pairs, projectsResult, licensesResult] = await Promise.all([
    db.listPairs(c.env).catch(() => []),
    session.role === "admin"
      ? loadVisibuildProjects(cfg)
      : Promise.resolve<VisibuildProjectsResult>({ projects: null }),
    session.role === "admin"
      ? loadReviztoLicenses(c.env, cfg)
      : Promise.resolve<ReviztoLicensesResult>({ licenses: null }),
  ]);

  let reviztoProjects: ReviztoProject[] | null = null;
  let reviztoError = licensesResult.error;
  if (selectedLicense && session.role === "admin" && licensesResult.licenses) {
    try {
      reviztoProjects = await revizto.listProjects(c.env, reviztoConnection(cfg), selectedLicense);
    } catch (e) {
      reviztoError = `Couldn't load that licence's projects: ${errorMessage(e)}`;
    }
  }

  return c.html(
    pairsPage({
      theme: themeFor(cfg),
      role: session.role,
      message: readFlash(c),
      pairs,
      visibuildProjects: projectsResult.projects,
      visibuildError: projectsResult.error,
      licenses: licensesResult.licenses,
      reviztoError,
      selectedLicense,
      reviztoProjects,
    }),
  );
});

app.post("/pairs", requireAdmin, async (c) => {
  const cfg = await loadConfig(c.env);
  const form = await c.req.formData();
  const visibuildProjectId = String(form.get("visibuildProject") ?? "").trim();
  // The Revizto option carries uuid|id|title, because a pair needs all three:
  // the integer id to create issues, the uuid for everything else.
  const [reviztoProjectUuid, reviztoProjectIdRaw, ...titleParts] = String(form.get("reviztoProject") ?? "").split("|");
  const licenseUuid = String(form.get("license") ?? "").trim();

  if (!visibuildProjectId || !reviztoProjectUuid || !reviztoProjectIdRaw || !licenseUuid) {
    return c.redirect(`/pairs${flash("error", "Choose a Visibuild project, a licence, and a Revizto project.")}`);
  }

  const projects = await vb.listProjects(visibuildCredentials(cfg)).catch(() => [] as Project[]);
  const visibuildProjectName = projects.find((p) => p.id === visibuildProjectId)?.name ?? visibuildProjectId;

  try {
    const pair = await db.createPair(c.env, {
      visibuildProjectId,
      visibuildProjectName,
      reviztoRegion: cfg.reviztoRegion,
      reviztoLicenseUuid: licenseUuid,
      reviztoProjectUuid,
      reviztoProjectId: Number(reviztoProjectIdRaw),
      reviztoProjectName: titleParts.join("|"),
    });
    return c.redirect(`/pairs/${pair.id}${flash("info", "Pair created. Map its statuses and types before the first sync.")}`);
  } catch (e) {
    const duplicate = /UNIQUE/i.test((e as Error).message);
    return c.redirect(
      `/pairs${flash("error", duplicate ? "Those two projects are already paired." : errorMessage(e))}`,
    );
  }
});

/** Everything the mapping editor needs, gathered in one place. */
async function mappingPageData(env: Env, cfg: AppConfig, pair: db.ProjectPair, mapping: PairMapping) {
  const conn = { ...reviztoConnection(cfg), region: pair.reviztoRegion };

  const [workflow, members, context, counts] = await Promise.all([
    revizto.getWorkflowSettings(env, conn, pair.reviztoProjectUuid).catch(() => null),
    revizto.listMembers(env, conn, pair.reviztoProjectUuid).catch(() => null),
    loadProjectContext(env, visibuildCredentials(cfg), pair.visibuildProjectId).catch(() => null),
    db.countLinks(env, pair.id).catch(() => ({ total: 0, errored: 0 })),
  ]);

  const visibuildUsers: MappableUser[] = context
    ? [...context.projectUsers]
        .map(([id, u]) => ({ id, name: u.name, email: u.email, companyName: u.companyName }))
        .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
    : [];

  const visibuildCompanies: MappableCompany[] = context
    ? [...context.projectCompanies]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  // Offer the documented type vocabulary plus anything already mapped, so a
  // type this API version doesn't list is still editable.
  const mappedTypes = Object.keys(mapping.types)
    .filter((k) => k.startsWith("type:"))
    .map((k) => k.slice("type:".length));
  const visiTypes = [...new Set([...VISI_TYPES, ...mappedTypes])].sort();

  return {
    reviztoStatuses: workflow?.statuses ?? null,
    reviztoTypes: workflow?.types ?? null,
    reviztoMembers: members,
    visibuildUsers,
    visibuildCompanies,
    locations: context ? [...context.locations.values()] : [],
    subtypes: context ? [...context.subtypes.values()] : [],
    visiTypes,
    linked: counts.total,
    errored: counts.errored,
  };
}

app.get("/pairs/:id", requireViewer, async (c) => {
  const cfg = await loadConfig(c.env);
  const session = c.get("session");
  const pair = await db.getPair(c.env, c.req.param("id"));
  if (!pair) return c.redirect(`/pairs${flash("error", "That project pair no longer exists.")}`);

  const mapping = await loadMapping(c.env, pair.id);
  const data = await mappingPageData(c.env, cfg, pair, mapping);

  return c.html(
    mappingPage({
      theme: themeFor(cfg),
      role: session.role,
      message: readFlash(c),
      pair,
      mapping,
      ...data,
      reviztoError: data.reviztoStatuses ? undefined : "Revizto's workflow settings could not be loaded. Check the connection in Settings.",
      visibuildError: data.visibuildUsers.length ? undefined : "Visibuild project members could not be loaded.",
    }),
  );
});

/**
 * Save a mapping.
 *
 * The form uses namespaced field names (`status:open`, `type:category:defect`,
 * `user:<id>`, `depth:2`, `loc:<id>:level`) so a variable number of rows can be
 * posted without any client-side bookkeeping.
 */
function parseMappingForm(form: FormData, current: PairMapping): PairMapping {
  const next: PairMapping = { ...defaultMapping(), ...current };

  const str = (key: string) => String(form.get(key) ?? "").trim();
  const collect = (prefix: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (!key.startsWith(prefix)) continue;
      const v = String(value).trim();
      if (v) out[key.slice(prefix.length)] = v;
    }
    return out;
  };

  next.titleTemplate = str("titleTemplate") || defaultMapping().titleTemplate;
  next.statuses = collect("status:");
  next.defaultStatus = str("defaultStatus");
  next.types = collect("type:");
  next.defaultType = str("defaultType");
  next.users = collect("user:");
  next.companies = collect("company:");
  next.defaultAssignee = str("defaultAssignee").toLowerCase();
  next.defaultReporter = str("defaultReporter").toLowerCase();

  next.locationDepths = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("depth:")) continue;
    next.locationDepths[key.slice("depth:".length)] = String(value).trim() as PairMapping["locationDepths"][string];
  }

  next.locationOverrides = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("loc:")) continue;
    const v = String(value).trim();
    if (!v) continue;
    // loc:<locationId>:<field> – the location id is a UUID, so split from the right.
    const rest = key.slice("loc:".length);
    const idx = rest.lastIndexOf(":");
    if (idx <= 0) continue;
    const locationId = rest.slice(0, idx);
    const field = rest.slice(idx + 1);
    const entry = next.locationOverrides[locationId] ?? {};
    (entry as Record<string, string>)[field] = v;
    next.locationOverrides[locationId] = entry;
  }

  next.tagPassthrough = Boolean(form.get("tagPassthrough"));
  next.tagPrefix = str("tagPrefix");
  const derived = { ...defaultMapping().derivedTags };
  for (const key of Object.keys(derived) as (keyof typeof derived)[]) {
    derived[key] = Boolean(form.get(`derived:${key}`));
  }
  next.derivedTags = derived;

  next.priorityRules = collect("prio:") as PairMapping["priorityRules"];
  next.defaultPriority = str("defaultPriority") as PairMapping["defaultPriority"];
  next.visibility = str("visibility") === "0" ? 0 : 1;

  next.filters = form.get("scopeOverride")
    ? {
        categories: form.getAll("scopeCategory").map(String),
        types: [],
        statuses: form.getAll("scopeStatus").map(String),
        includeArchived: Boolean(form.get("scopeIncludeArchived")),
        rootOnly: Boolean(form.get("scopeRootOnly")),
      }
    : null;

  // The normaliser is the single place that validates vocabularies, so run the
  // parsed form back through it rather than trusting the POST.
  return normalizeMapping(next);
}

app.post("/pairs/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const pair = await db.getPair(c.env, id);
  if (!pair) return c.redirect(`/pairs${flash("error", "That project pair no longer exists.")}`);

  const form = await c.req.formData();
  const current = await loadMapping(c.env, id);
  await saveMapping(c.env, id, parseMappingForm(form, current));
  return c.redirect(`/pairs/${id}${flash("success", "Mapping saved.")}`);
});

app.post("/pairs/:id/sync", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const summary = await runSync(c.env, { trigger: "manual", pairId: id });
  return c.redirect(`/runs/${summary.runId}`);
});

app.post("/pairs/:id/toggle", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const pair = await db.getPair(c.env, id);
  if (!pair) return c.redirect(`/pairs${flash("error", "That project pair no longer exists.")}`);
  await db.setPairEnabled(c.env, id, !pair.enabled);
  return c.redirect(`/pairs/${id}${flash("success", pair.enabled ? "Sync paused." : "Sync resumed.")}`);
});

app.post("/pairs/:id/reset", requireAdmin, async (c) => {
  const id = c.req.param("id");
  await db.resetPairCursors(c.env, id);
  return c.redirect(
    `/pairs/${id}${flash("info", "Watermarks cleared. The next run re-checks every visi; existing issues are updated, not duplicated.")}`,
  );
});

app.post("/pairs/:id/delete", requireAdmin, async (c) => {
  const id = c.req.param("id");
  await db.deletePair(c.env, id);
  await deleteMapping(c.env, id);
  return c.redirect(`/pairs${flash("success", "Pair deleted. The Revizto issues themselves were left alone.")}`);
});

// ---------------------------------------------------------------------------
// Sync log
// ---------------------------------------------------------------------------

app.get("/runs", requireViewer, async (c) => {
  const cfg = await loadConfig(c.env);
  const session = c.get("session");
  const runs = await db.listRuns(c.env, 40).catch(() => []);
  return c.html(runsPage({ theme: themeFor(cfg), role: session.role, message: readFlash(c), runs }));
});

const EVENT_PAGE_SIZE = 400;

app.get("/runs/:id", requireViewer, async (c) => {
  const cfg = await loadConfig(c.env);
  const session = c.get("session");
  const run = await db.getRun(c.env, c.req.param("id"));
  if (!run) return c.redirect(`/runs${flash("error", "That sync run no longer exists.")}`);

  const [events, pairs] = await Promise.all([
    db.listEvents(c.env, run.id, EVENT_PAGE_SIZE),
    db.listPairs(c.env).catch(() => []),
  ]);

  return c.html(
    runDetailPage({
      theme: themeFor(cfg),
      role: session.role,
      run,
      events,
      pairNames: new Map(pairs.map((p) => [p.id, p.visibuildProjectName || p.visibuildProjectId])),
      truncated: events.length >= EVENT_PAGE_SIZE,
    }),
  );
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface WebhooksResult {
  list: WebhookEndpoint[] | null;
  error?: string;
}

async function loadWebhooks(cfg: AppConfig): Promise<WebhooksResult> {
  if (!hasVisibuildCredentials(cfg)) return { list: null };
  try {
    return { list: await webhooks.listWebhooks(visibuildCredentials(cfg)) };
  } catch (e) {
    return { list: null, error: `Couldn't load webhook endpoints: ${errorMessage(e)}` };
  }
}

async function renderSettings(
  c: any,
  cfg: AppConfig,
  message?: PageMessage,
  newWebhookSecret?: string,
  messageSection?: SettingsSection,
): Promise<Response> {
  const [tokens, hooks] = await Promise.all([
    oauth.loadTokens(c.env),
    SHOW_WEBHOOKS ? loadWebhooks(cfg) : Promise.resolve<WebhooksResult>({ list: null }),
  ]);
  return c.html(
    settingsPage({
      theme: themeFor(cfg),
      cfg,
      message,
      messageSection,
      hasVisibuildSecret: Boolean(cfg.visibuildClientSecret),
      hasReviztoSecret: Boolean(cfg.reviztoClientSecret),
      hasViewerPassword: Boolean(cfg.viewerPassword),
      tokens,
      redirectUri: oauth.redirectUriFor(c.req.url),
      webhooks: hooks.list,
      webhooksError: hooks.error,
      newWebhookSecret,
    }),
  );
}

app.get("/settings", requireAdmin, async (c) => {
  const cfg = await loadConfig(c.env);
  const requested = c.req.query("section") ?? "";
  const section = (SETTINGS_SECTIONS as readonly string[]).includes(requested)
    ? (requested as SettingsSection)
    : undefined;
  return renderSettings(c, cfg, readFlash(c), undefined, section);
});

function parseFilters(form: FormData): SyncFilters {
  const allowed = <T extends readonly string[]>(values: string[], vocabulary: T) =>
    values.filter((v) => (vocabulary as readonly string[]).includes(v));
  return {
    categories: allowed(form.getAll("filterCategory").map(String), VISI_CATEGORIES),
    types: allowed(form.getAll("filterType").map(String), VISI_TYPES),
    statuses: allowed(form.getAll("filterStatus").map(String), VISI_STATUSES),
    includeArchived: Boolean(form.get("includeArchived")),
    rootOnly: Boolean(form.get("rootOnly")),
  };
}

/**
 * Build the patch for one section.
 *
 * Only the posted section's fields are touched. That is the whole point of the
 * split: an unticked checkbox in a section that was not submitted must not be
 * read as "turn this off", and saving Visibuild's credentials must not rewrite
 * Revizto's.
 */
function patchForSection(section: SettingsSection, form: FormData, current: AppConfig): Partial<AppConfig> {
  const str = (key: string) => String(form.get(key) ?? "").trim();
  // A blank secret means "keep the stored one", so it can stay masked in the form.
  const keepIfBlank = (key: string, value: string): Partial<AppConfig> => (value ? { [key]: value } : {});

  switch (section) {
    case "visibuild":
      return {
        visibuildApiUrl: str("visibuildApiUrl") || current.visibuildApiUrl,
        visibuildClientId: str("visibuildClientId"),
        ...keepIfBlank("visibuildClientSecret", str("visibuildClientSecret")),
      };

    case "revizto":
      return {
        reviztoRegion: REVIZTO_REGIONS.some((r) => r.id === str("reviztoRegion"))
          ? str("reviztoRegion")
          : current.reviztoRegion,
        reviztoClientId: str("reviztoClientId"),
        ...keepIfBlank("reviztoClientSecret", str("reviztoClientSecret")),
      };

    case "scope":
      return { filters: parseFilters(form) };

    case "content":
      return {
        content: {
          description: Boolean(form.get("contentDescription")),
          backLink: Boolean(form.get("contentBackLink")),
          requirements: Boolean(form.get("contentRequirements")),
          statusHistory: Boolean(form.get("contentStatusHistory")),
          attachments: Boolean(form.get("contentAttachments")),
        },
      };

    case "limits":
      return {
        limits: {
          visisPerRun: Number(str("visisPerRun")) || current.limits.visisPerRun,
          attachmentsPerRun: Number(str("attachmentsPerRun")) || current.limits.attachmentsPerRun,
          maxAttachmentMb: Number(str("maxAttachmentMb")) || current.limits.maxAttachmentMb,
        },
      };

    case "access":
      return keepIfBlank("viewerPassword", str("viewerPassword"));

    case "branding":
      return {
        brandLabel: str("brandLabel") || DEFAULT_BRAND,
        logoUrl: sanitizeLogoUrl(str("logoUrl")),
        faviconUrl: sanitizeLogoUrl(str("faviconUrl")),
        primaryColor: sanitizeHexColor(str("primaryColor"), DEFAULT_PRIMARY),
      };
  }
}

/** Test only the connection the operator just saved, not both. */
async function testSection(
  c: any,
  section: SettingsSection,
  cfg: AppConfig,
): Promise<PageMessage> {
  if (section === "visibuild") {
    const result = hasVisibuildCredentials(cfg)
      ? await vb.testConnection(visibuildCredentials(cfg))
      : { ok: false, message: "Visibuild credentials are incomplete." };
    return { kind: result.ok ? "success" : "error", text: result.message };
  }

  if (!hasReviztoCredentials(cfg)) {
    return { kind: "error", text: "Add the Revizto region, client ID and client secret first." };
  }
  if (!(await oauth.loadTokens(c.env))) {
    // Credentials alone prove nothing here: Revizto has no machine-to-machine
    // grant, so there is nothing to test until someone has connected.
    return { kind: "info", text: "Credentials saved. Press Connect Revizto to authorise the sync." };
  }
  const result = await revizto.testConnection(c.env, reviztoConnection(cfg));
  return { kind: result.ok ? "success" : "error", text: result.message };
}

app.post("/settings", requireAdmin, async (c) => {
  const form = await c.req.formData();
  const section = String(form.get("section") ?? "") as SettingsSection;
  if (!SETTINGS_SECTIONS.includes(section)) {
    const cfg = await loadConfig(c.env);
    return renderSettings(c, cfg, { kind: "error", text: "That form could not be read. Try again." });
  }

  const current = await loadConfig(c.env);
  const cfg = await saveConfig(c.env, patchForSection(section, form, current));

  // Credentials or scope may have changed; drop the cached Visibuild lookups.
  if (section === "visibuild" || section === "scope") {
    vb.resetTokenCache();
    resetContextCache();
  }

  const message: PageMessage =
    String(form.get("action") ?? "save") === "test"
      ? await testSection(c, section, cfg)
      : { kind: "success", text: "Saved." };

  // Post-redirect-get, anchored to the section that was saved: the confirmation
  // lands next to the fields it refers to rather than at the top of a long page,
  // and a refresh re-reads the page instead of re-submitting the form.
  const params = new URLSearchParams({ msg: message.text, kind: message.kind, section });
  return c.redirect(`/settings?${params.toString()}#${section}`);
});

// ---------------------------------------------------------------------------
// Revizto OAuth
// ---------------------------------------------------------------------------

app.get("/settings/revizto/connect", requireAdmin, async (c) => {
  const cfg = await loadConfig(c.env);
  if (!hasReviztoCredentials(cfg)) {
    return c.redirect(`/settings${flash("error", "Add the Revizto region, client ID and client secret first.")}`);
  }
  const url = await oauth.beginAuth(c.env, {
    region: cfg.reviztoRegion,
    clientId: cfg.reviztoClientId,
    redirectUri: oauth.redirectUriFor(c.req.url),
  });
  return c.redirect(url);
});

app.get("/settings/revizto/callback", requireAdmin, async (c) => {
  const cfg = await loadConfig(c.env);
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";

  const pending = await oauth.takePendingAuth(c.env, state);
  if (!pending) {
    return c.redirect(`/settings${flash("error", "That sign-in attempt expired or was already used. Try connecting again.")}`);
  }
  if (!code) {
    // Revizto reports authorize-step failures to the user, not the callback,
    // but a cancelled sign-in can still land here without a code.
    return c.redirect(`/settings${flash("error", "Revizto did not return an authorisation code.")}`);
  }

  try {
    const tokens = await oauth.exchangeCode(
      pending.region,
      { clientId: cfg.reviztoClientId, clientSecret: cfg.reviztoClientSecret },
      { code, redirectUri: pending.redirectUri, verifier: pending.verifier },
    );

    await oauth.saveTokens(c.env, {
      region: pending.region,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + tokens.expiresIn,
      refreshToken: tokens.refreshToken,
      connectedEmail: "",
      connectedName: "",
      connectedAt: new Date().toISOString(),
    });

    // Record who the sync now acts as, so the dashboard can say so.
    const conn = { ...reviztoConnection(cfg), region: pending.region };
    const user = await revizto.getCurrentUser(c.env, conn).catch(() => null);
    if (user) {
      const stored = await oauth.loadTokens(c.env);
      if (stored) {
        await oauth.saveTokens(c.env, { ...stored, connectedEmail: user.email, connectedName: user.name });
      }
    }

    return c.redirect(
      `/settings${flash("success", `Connected to Revizto${user ? ` as ${user.name || user.email}` : ""}.`)}`,
    );
  } catch (e) {
    return c.redirect(`/settings${flash("error", `Revizto sign-in failed: ${errorMessage(e)}`)}`);
  }
});

app.post("/settings/revizto/disconnect", requireAdmin, async (c) => {
  await oauth.clearTokens(c.env);
  return c.redirect(`/settings${flash("info", "Revizto disconnected. The sync will not run until you reconnect.")}`);
});

// ---------------------------------------------------------------------------
// Visibuild webhooks (registered now, unused until Visibuild emits visi events)
// ---------------------------------------------------------------------------

if (SHOW_WEBHOOKS) {
  app.post("/settings/webhooks", requireAdmin, async (c) => {
    const cfg = await loadConfig(c.env);
    const form = await c.req.formData();
    const url = String(form.get("url") ?? "").trim();
    const events = String(form.get("events") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!url || events.length === 0) {
      return renderSettings(c, cfg, { kind: "error", text: "A webhook needs a URL and at least one event." });
    }

    try {
      const created = await webhooks.createWebhook(visibuildCredentials(cfg), { url, events });
      // The signing secret is returned exactly once, so surface it immediately.
      return renderSettings(
        c,
        cfg,
        { kind: "success", text: "Webhook endpoint registered." },
        created.secret,
      );
    } catch (e) {
      return renderSettings(c, cfg, { kind: "error", text: errorMessage(e) });
    }
  });

  app.post("/settings/webhooks/delete", requireAdmin, async (c) => {
    const cfg = await loadConfig(c.env);
    const form = await c.req.formData();
    try {
      await webhooks.deleteWebhook(visibuildCredentials(cfg), String(form.get("id") ?? ""));
      return c.redirect(`/settings${flash("success", "Webhook endpoint deleted.")}`);
    } catch (e) {
      return c.redirect(`/settings${flash("error", errorMessage(e))}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

app.notFound(async (c) => {
  const theme = themeFor(await loadConfig(c.env));
  const body = `<div class="login-wrap"><div class="login-card">
    <span class="brand-icon brand-icon--lg"><img src="/app-icon.png" alt=""></span>
    <div class="login-title">Page not found</div>
    <div class="login-sub">${esc("The page you're looking for doesn't exist.")}</div>
    <a class="btn btn-primary btn-block" href="/">Go to the dashboard</a>
  </div></div>`;
  return c.html(layout({ title: "Not found", body, theme }), 404);
});

export default {
  fetch: app.fetch,

  /**
   * The hourly cron. Failures are logged rather than thrown: the run itself
   * records what happened in the sync log, which is where an operator looks.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runSync(env, { trigger: "cron" }).then(
        (summary) => {
          console.log(
            `Sync ${summary.status}: ${summary.created} created, ${summary.updated} updated, ${summary.skipped} unchanged, ${summary.failed} failed.`,
          );
        },
        (e) => console.error("Sync run threw:", e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
