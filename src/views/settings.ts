/**
 * views/settings.ts – connections, global sync scope, webhooks and branding.
 *
 * Each section is its own form, posting a `section` marker. That matters more
 * than it looks: a single page-wide form would mean saving your Visibuild
 * credentials also rewrote the Revizto ones, the scope and the branding from
 * whatever happened to be on screen – and an unticked checkbox in a section you
 * were not looking at would silently turn that option off.
 *
 * The Revizto section is the other thing worth reading. Revizto has no
 * machine-to-machine grant, so connecting means an admin runs the OAuth flow
 * once and the Worker keeps the (rotating) refresh token. Two things therefore
 * have to be shown plainly: the exact redirect URI to register in Revizto's
 * developer portal, and who the sync is currently acting as.
 */
import type { AppConfig } from "../config";
import type { WebhookEndpoint } from "../visibuild/types";
import {
  REVIZTO_REGIONS,
  regionLabel,
  type ReviztoTokens,
} from "../revizto/types";
import { VISI_CATEGORIES, VISI_STATUSES, VISI_TYPES } from "../visibuild/types";
import {
  checkbox,
  message,
  pageHeader,
  select,
  type PageMessage,
} from "./components";
import {
  esc,
  fmtDate,
  healthBadge,
  humanise,
  layout,
  type Theme,
} from "./layout";

/**
 * Webhooks are built but not shown. Visibuild emits no event that would help
 * the sync yet, so the section is only a way to register endpoints that nothing
 * consumes. Flip this to true (and the plumbing in `visibuild/webhooks.ts` and
 * the two routes in `index.ts` is already there) once those events land.
 */
export const SHOW_WEBHOOKS = false;

/** The independently savable parts of this page. */
export const SETTINGS_SECTIONS = [
  "visibuild",
  "revizto",
  "scope",
  "content",
  "limits",
  "access",
  "branding",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface SettingsPageOptions {
  theme: Theme;
  cfg: AppConfig;
  message?: PageMessage;
  /** Which section the message belongs to, so it appears beside what was saved. */
  messageSection?: SettingsSection;
  hasVisibuildSecret: boolean;
  hasReviztoSecret: boolean;
  hasViewerPassword: boolean;
  tokens: ReviztoTokens | null;
  /** The URI this deployment will send Revizto back to. */
  redirectUri: string;
  /** Null when Visibuild is not connected; the endpoint list otherwise. */
  webhooks: WebhookEndpoint[] | null;
  webhooksError?: string;
  /** Shown once, immediately after creating an endpoint. */
  newWebhookSecret?: string;
}

/**
 * Wrap a section's fields in their own form. Only this section's values are
 * posted, so saving one never disturbs another.
 */
function sectionForm(
  section: SettingsSection,
  title: string,
  fields: string,
  opts: { saveLabel?: string; testLabel?: string; extra?: string; message?: string } = {},
): string {
  const test = opts.testLabel
    ? `<button type="submit" class="btn btn-ghost" name="action" value="test">${esc(opts.testLabel)}</button>`
    : "";
  // The id gives the save redirect something to scroll back to.
  return `<p class="form-section-title" id="${esc(section)}">${esc(title)}</p>
    <div class="card">
      ${opts.message ?? ""}
      <form method="post" action="/settings" autocomplete="off">
        <input type="hidden" name="section" value="${esc(section)}">
        ${fields}
        <div class="actions-row">
          <button type="submit" class="btn btn-primary" name="action" value="save">${esc(opts.saveLabel ?? "Save")}</button>
          ${test}
        </div>
      </form>
      ${opts.extra ?? ""}
    </div>`;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function visibuildFields(opts: SettingsPageOptions): string {
  const { cfg } = opts;
  return `<div class="form-group">
      <label for="visibuildApiUrl">API base URL</label>
      <input type="text" id="visibuildApiUrl" name="visibuildApiUrl" value="${esc(cfg.visibuildApiUrl)}"
        placeholder="https://app.apac.visibuild.com/api/core/v1">
      <p class="field-hint">AU, EU and US each have their own host.</p>
    </div>
    <div class="form-group">
      <label for="visibuildClientId">OAuth client ID</label>
      <input type="text" id="visibuildClientId" name="visibuildClientId" value="${esc(cfg.visibuildClientId)}">
    </div>
    <div class="form-group">
      <label for="visibuildClientSecret">OAuth client secret</label>
      <input type="password" id="visibuildClientSecret" name="visibuildClientSecret" placeholder="${
        opts.hasVisibuildSecret
          ? "•••••••• (leave blank to keep)"
          : "Your Visibuild client secret"
      }">
      <p class="field-hint">
        Create credentials in Visibuild under Company settings → API (client credentials grant, read scope).
      </p>
    </div>`;
}

function reviztoFields(opts: SettingsPageOptions): string {
  const { cfg } = opts;
  return `<div class="form-group">
      <label for="reviztoRegion">Region</label>
      ${select(
        "reviztoRegion",
        REVIZTO_REGIONS.map((r) => ({
          value: r.id,
          label: `${r.label} – ${r.host.replace("https://", "")}`,
        })),
        cfg.reviztoRegion,
        { id: "reviztoRegion" },
      )}
      <p class="field-hint">
        Regions are fully independent: an application, and the tokens it issues, belong to exactly one.
      </p>
    </div>
    <div class="form-group">
      <label for="reviztoClientId">Application client ID</label>
      <input type="text" id="reviztoClientId" name="reviztoClientId" value="${esc(cfg.reviztoClientId)}">
    </div>
    <div class="form-group">
      <label for="reviztoClientSecret">Application client secret</label>
      <input type="password" id="reviztoClientSecret" name="reviztoClientSecret" placeholder="${
        opts.hasReviztoSecret
          ? "•••••••• (leave blank to keep)"
          : "Your Revizto client secret"
      }">
      <p class="field-hint">
        Register an application in Revizto Workspace → Developer portal, then activate it.
        The secret is shown exactly once, so save it before closing that dialog.
      </p>
    </div>
    <div class="form-group">
      <label>Redirect URI</label>
      <p><code class="copy-target">${esc(opts.redirectUri)}</code></p>
      <p class="field-hint">
        Register this in the developer portal exactly as shown – a trailing slash or an <code>http</code>
        instead of <code>https</code> is enough to be rejected as <code>invalid_client</code>.
      </p>
    </div>`;
}

/**
 * The connection itself, kept outside the credentials form: it is a separate
 * action (and Disconnect is its own form, which cannot be nested inside one).
 */
function reviztoConnection(opts: SettingsPageOptions): string {
  const t = opts.tokens;

  const status = !t
    ? `${healthBadge(false, "Not connected")} <span class="text-muted">No Revizto authorisation is stored.</span>`
    : t.needsReauth
      ? `${healthBadge(false, "Reconnect needed")} <span class="text-muted">${esc(
          t.lastError || "The stored authorisation has lapsed.",
        )}</span>`
      : `${healthBadge(true, "Connected")} <span class="text-muted">Acting as ${esc(
          t.connectedName || t.connectedEmail,
        )} in ${esc(regionLabel(t.region))}, connected ${fmtDate(t.connectedAt)}.</span>`;

  const disconnect = t
    ? `<form method="post" action="/settings/revizto/disconnect" style="display:inline"
         data-confirm="Disconnect Revizto? The sync will stop until you reconnect.">
         <button type="submit" class="btn btn-ghost">Disconnect</button>
       </form>`
    : "";

  return `<div class="section-divider">
      <label>Connection</label>
      <p>${status}</p>
      <p class="field-hint">
        Revizto has no machine-to-machine flow: the sync acts as the person who connects here, so use an
        account that will stay in the projects you are mirroring into. Save the client ID and secret above
        first, then connect.
      </p>
      <div class="actions-row">
        <a class="btn btn-primary" href="/settings/revizto/connect">${t ? "Reconnect Revizto" : "Connect Revizto"}</a>
        ${disconnect}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Scope, content and limits
// ---------------------------------------------------------------------------

function scopeFields(cfg: AppConfig): string {
  const categories = VISI_CATEGORIES.map((c) =>
    checkbox(
      "filterCategory",
      humanise(c),
      cfg.filters.categories.includes(c),
      c,
    ),
  ).join("");
  const types = VISI_TYPES.map((t) =>
    checkbox("filterType", humanise(t), cfg.filters.types.includes(t), t),
  ).join("");
  const statuses = VISI_STATUSES.map((s) =>
    checkbox("filterStatus", humanise(s), cfg.filters.statuses.includes(s), s),
  ).join("");

  return `<p class="field-hint" style="margin-bottom:12px">
      The default scope for every pair. A pair can override it on its own mapping page.
      Tick nothing in a group to allow everything in it.
    </p>
    <div class="form-group">
      <label>Categories</label>
      <div class="checkbox-list">${categories}</div>
    </div>
    <div class="form-group">
      <label>Types</label>
      <div class="checkbox-list">${types}</div>
    </div>
    <div class="form-group">
      <label>Statuses</label>
      <div class="checkbox-list">${statuses}</div>
    </div>
    <div class="form-group">
      ${checkbox("rootOnly", "Root visis only", cfg.filters.rootOnly)}
      ${checkbox("includeArchived", "Include archived visis", cfg.filters.includeArchived)}
    </div>`;
}

function contentFields(cfg: AppConfig): string {
  return `<p class="field-hint" style="margin-bottom:12px">
      A Revizto issue has a title and comments, but no description field – so everything below is written
      as a comment on the issue.
    </p>
    <div class="checkbox-list">
      ${checkbox("contentDescription", "Visi description", cfg.content.description)}
      ${checkbox("contentBackLink", "Link back to the visi in Visibuild", cfg.content.backLink)}
      ${checkbox("contentRequirements", "Checklist answers", cfg.content.requirements)}
      ${checkbox("contentStatusHistory", "Status-change history", cfg.content.statusHistory)}
      ${checkbox("contentAttachments", "Photos and attachments", cfg.content.attachments)}
    </div>
    <p class="field-hint">
      Attachments are downloaded from Visibuild and re-uploaded to Revizto, so they are the slowest part
      of a run – the run limits keep a single run inside the Worker's budget.
    </p>`;
}

function limitFields(cfg: AppConfig): string {
  return `<div class="form-group">
      <label for="visisPerRun">Visis per run, per project</label>
      <input type="number" id="visisPerRun" name="visisPerRun" min="1" max="2000" value="${esc(cfg.limits.visisPerRun)}">
    </div>
    <div class="form-group">
      <label for="attachmentsPerRun">Attachments per run, per project</label>
      <input type="number" id="attachmentsPerRun" name="attachmentsPerRun" min="0" max="500" value="${esc(cfg.limits.attachmentsPerRun)}">
    </div>
    <div class="form-group">
      <label for="maxAttachmentMb">Largest attachment (MB)</label>
      <input type="number" id="maxAttachmentMb" name="maxAttachmentMb" min="1" max="38" value="${esc(cfg.limits.maxAttachmentMb)}">
      <p class="field-hint">Revizto's own ceiling is 38 MB. Anything larger is skipped and noted in the sync log.</p>
    </div>
    <p class="field-hint">
      Hitting a cap is not an error: the watermark only advances over what was done, so the next run picks
      up exactly where this one stopped.
    </p>`;
}

function accessFields(opts: SettingsPageOptions): string {
  return `<div class="form-group">
      <label for="viewerPassword">Viewer password</label>
      <input type="password" id="viewerPassword" name="viewerPassword" placeholder="${
        opts.hasViewerPassword
          ? "•••••••• (leave blank to keep)"
          : "Set a password for read-only access"
      }">
      <p class="field-hint">${
        opts.hasViewerPassword
          ? "Anyone with this password can watch the dashboard and the sync log, but cannot change anything."
          : "Optional. Set one to let someone watch the dashboard and sync log without admin access."
      }</p>
    </div>`;
}

function brandingFields(cfg: AppConfig): string {
  return `<div class="form-group">
      <label for="brandLabel">Site name</label>
      <input type="text" id="brandLabel" name="brandLabel" value="${esc(cfg.brandLabel)}">
    </div>
    <div class="form-group">
      <label for="logoUrl">Logo URL</label>
      <input type="url" id="logoUrl" name="logoUrl" value="${esc(cfg.logoUrl)}" placeholder="https://example.com/logo.png">
    </div>
    <div class="form-group">
      <label for="faviconUrl">Favicon URL</label>
      <input type="url" id="faviconUrl" name="faviconUrl" value="${esc(cfg.faviconUrl)}" placeholder="https://example.com/favicon.ico">
    </div>
    <div class="form-group">
      <label for="primaryColor">Primary colour</label>
      <div class="color-row">
        <input type="color" id="primaryColor" name="primaryColor" value="${esc(cfg.primaryColor)}">
        <code>${esc(cfg.primaryColor)}</code>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Webhooks (hidden – see SHOW_WEBHOOKS)
// ---------------------------------------------------------------------------

export function webhookSection(opts: SettingsPageOptions): string {
  const intro = `<p class="field-hint" style="margin-bottom:12px">
      Visibuild does not yet emit an event for visi changes, so the sync polls on a schedule instead.
      Endpoints registered here are not used by the sync yet – they are here so the plumbing is ready
      when those events arrive.
    </p>`;

  if (opts.webhooks === null) {
    return `${intro}<p class="field-hint">${esc(
      opts.webhooksError || "Connect Visibuild to manage webhook endpoints.",
    )}</p>`;
  }

  const secretNote = opts.newWebhookSecret
    ? `<div class="message info">
         Signing secret (shown once, and never again): <code>${esc(opts.newWebhookSecret)}</code>
       </div>`
    : "";

  const rows = opts.webhooks
    .map(
      (w) => `<div class="webhook-row">
        <div>
          <div><code>${esc(w.url)}</code></div>
          <div class="text-muted">
            ${esc(w.events.join(", ") || "no events")}
            ${w.failureCount > 0 ? ` · <span class="badge action-error">${w.failureCount} failures</span>` : ""}
            ${w.enabled ? "" : ` · <span class="badge action-skip">Disabled</span>`}
          </div>
        </div>
        <form method="post" action="/settings/webhooks/delete"
          data-confirm="Delete this webhook endpoint?">
          <input type="hidden" name="id" value="${esc(w.id)}">
          <button type="submit" class="btn btn-ghost btn-sm">Delete</button>
        </form>
      </div>`,
    )
    .join("");

  return `${intro}
    ${secretNote}
    ${rows || `<p class="field-hint">No endpoints registered.</p>`}
    <form method="post" action="/settings/webhooks" class="webhook-form">
      <div class="form-group">
        <label for="webhookUrl">Endpoint URL</label>
        <input type="url" id="webhookUrl" name="url" placeholder="https://example.com/webhooks" required>
      </div>
      <div class="form-group">
        <label for="webhookEvents">Events</label>
        <input type="text" id="webhookEvents" name="events" placeholder="visi.created, visi.updated">
        <p class="field-hint">Comma-separated event names, as documented by Visibuild.</p>
      </div>
      <button type="submit" class="btn btn-ghost">Register endpoint</button>
    </form>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function settingsPage(opts: SettingsPageOptions): string {
  const { cfg } = opts;

  /** Show the confirmation against the section it belongs to. */
  const messageFor = (section: SettingsSection) =>
    opts.messageSection === section ? message(opts.message) : "";

  const body = `<div class="container container--sm">
    ${pageHeader("Settings", "Each section saves on its own, so you can set one system up before the other.")}
    ${opts.messageSection ? "" : message(opts.message)}

    ${sectionForm("visibuild", "Visibuild connection", visibuildFields(opts), {
      testLabel: "Save & test",
      message: messageFor("visibuild"),
    })}

    ${sectionForm("revizto", "Revizto connection", reviztoFields(opts), {
      testLabel: "Save & test",
      extra: reviztoConnection(opts),
      message: messageFor("revizto"),
    })}

    ${sectionForm("scope", "Sync scope", scopeFields(cfg), { message: messageFor("scope") })}

    ${sectionForm("content", "What to carry across", contentFields(cfg), {
      message: messageFor("content"),
    })}

    ${sectionForm("limits", "Run limits", limitFields(cfg), { message: messageFor("limits") })}

    ${sectionForm("access", "Read-only access", accessFields(opts), {
      message: messageFor("access"),
    })}

    ${sectionForm("branding", "Branding", brandingFields(cfg), {
      message: messageFor("branding"),
    })}

    ${SHOW_WEBHOOKS ? `<p class="form-section-title">Webhooks</p><div class="card">${webhookSection(opts)}</div>` : ""}
  </div>`;

  return layout({
    title: `Settings · ${opts.theme.brandLabel}`,
    body,
    theme: opts.theme,
    nav: { role: "admin", active: "settings" },
  });
}
