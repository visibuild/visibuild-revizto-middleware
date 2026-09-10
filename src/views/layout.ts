/**
 * layout.ts – HTML shell, theming, and small rendering helpers.
 *
 * The whole colour palette derives from a single `--primary`, injected per
 * request from the configured brand colour. The logo and brand label are also
 * configurable. All page chrome (nav + footer) lives here.
 */
import type { Role } from "../auth";
import { humanise } from "../labels";

/** Per-request theme, built from the saved config (already sanitised). */
export interface Theme {
  brandLabel: string;
  logoUrl: string; // "" -> use the bundled icon
  faviconUrl: string; // "" -> use the bundled favicons
  primaryColor: string; // validated hex, e.g. "#5c7e6a"
}

/** Escape text for safe interpolation into HTML (text or attribute context). */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The Worker runtime is UTC; the API returns UTC timestamps. We can't know the
// viewer's timezone at render time, so we emit a <time> element that app.js
// rewrites to the device's local time. The server-rendered text is a fallback
// (for no-JS): formatted in an Australian timezone rather than raw UTC.
const FALLBACK_TIME_ZONE = "Australia/Melbourne";

/**
 * Format an ISO (UTC) timestamp as a <time> element. app.js converts the text to
 * the viewer's device timezone; without JS, the AU-timezone fallback shows.
 */
export function fmtDate(dt: string | null | undefined): string {
  if (!dt) return "–";
  const d = new Date(dt);
  if (isNaN(d.getTime())) return esc(dt);
  const fallback = d.toLocaleString("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: FALLBACK_TIME_ZONE,
  });
  return `<time datetime="${esc(d.toISOString())}" data-dt>${fallback}</time>`;
}

/** Visi statuses, as returned by the Visibuild Core API. */
const VISI_STATUSES = ["open", "in_progress", "in_review", "closed", "n_a", "cant_close"];

// Re-exported so the view modules can keep importing it from here.
export { humanise };

export function visiStatusBadge(status: string): string {
  const s = (status || "").toLowerCase();
  const cls = VISI_STATUSES.includes(s) ? `visi-${s.replace(/_/g, "-")}` : "visi-unknown";
  return `<span class="badge ${cls}">${esc(humanise(status))}</span>`;
}

/** The outcome of one visi in a sync run. */
export function actionBadge(action: string): string {
  const known = ["create", "update", "skip", "conflict", "error"];
  const a = (action || "").toLowerCase();
  const cls = known.includes(a) ? `action-${a}` : "action-skip";
  const labels: Record<string, string> = {
    create: "Created",
    update: "Updated",
    skip: "No change",
    conflict: "Overwrote",
    error: "Failed",
  };
  return `<span class="badge ${cls}">${esc(labels[a] ?? humanise(action))}</span>`;
}

/** The outcome of a whole sync run. */
export function runStatusBadge(status: string): string {
  const known = ["running", "ok", "partial", "failed"];
  const s = (status || "").toLowerCase();
  const cls = known.includes(s) ? `run-${s}` : "run-running";
  const labels: Record<string, string> = {
    running: "Running",
    ok: "Succeeded",
    partial: "Partial",
    failed: "Failed",
  };
  return `<span class="badge ${cls}">${esc(labels[s] ?? humanise(status))}</span>`;
}

/** A connected / not-connected pill for the dashboard and Settings. */
export function healthBadge(ok: boolean, label: string): string {
  return `<span class="badge ${ok ? "health-ok" : "health-bad"}">${esc(label)}</span>`;
}

// ---------------------------------------------------------------------------
// Sanitisers (defence in depth – values are validated before storage too)
// ---------------------------------------------------------------------------

export function sanitizeHexColor(value: string | undefined | null, fallback: string): string {
  const v = (value ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
}

export function sanitizeLogoUrl(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    /* not a valid URL */
  }
  return "";
}

// ---------------------------------------------------------------------------
// Brand mark + chrome
// ---------------------------------------------------------------------------

export function brandMark(theme: Theme, variant: "nav" | "login"): string {
  if (theme.logoUrl) {
    const cls = variant === "login" ? "login-logo" : "brand-logo";
    return `<img class="${cls}" src="${esc(theme.logoUrl)}" alt="${esc(theme.brandLabel)}">`;
  }
  const cls = variant === "login" ? "brand-icon brand-icon--lg" : "brand-icon";
  return `<span class="${cls}"><img src="/app-icon.png" alt=""></span>`;
}

interface NavOptions {
  role: Role;
  active?: "dashboard" | "pairs" | "runs" | "settings";
}

function navLink(href: string, label: string, active: boolean): string {
  return `<a class="nav-link ${active ? "active" : ""}" href="${esc(href)}">${esc(label)}</a>`;
}

function nav(theme: Theme, opts: NavOptions): string {
  const links = [
    navLink("/", "Dashboard", opts.active === "dashboard"),
    navLink("/pairs", "Projects", opts.active === "pairs"),
    navLink("/runs", "Sync log", opts.active === "runs"),
    opts.role === "admin" ? navLink("/settings", "Settings", opts.active === "settings") : "",
  ].join("");

  return `<nav class="app-nav">
    <a class="nav-brand" href="/">
      ${brandMark(theme, "nav")}
      <span class="brand-name">${esc(theme.brandLabel)}</span>
    </a>
    <div class="nav-center-group">${links}</div>
    <div class="nav-right">
      <form method="post" action="/logout" style="display:inline">
        <button type="submit" class="nav-link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign out
        </button>
      </form>
    </div>
  </nav>`;
}

function footer(): string {
  return `<footer class="app-footer">Visibuild <span aria-hidden="true">→</span> Revizto sync</footer>`;
}

export interface LayoutOptions {
  title: string;
  body: string;
  theme: Theme;
  /** Omit for bare (nav-less) pages like login. */
  nav?: NavOptions;
}

export function layout(opts: LayoutOptions): string {
  const primary = sanitizeHexColor(opts.theme.primaryColor, "#5c7e6a");
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(opts.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${
    opts.theme.faviconUrl
      ? `<link rel="icon" href="${esc(opts.theme.faviconUrl)}">
  <link rel="apple-touch-icon" href="${esc(opts.theme.faviconUrl)}">`
      : `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
  <link rel="apple-touch-icon" href="/app-icon.png">`
  }
  <link rel="stylesheet" href="/styles.css">
  <style>:root{--primary:${primary}}</style>
</head>
<body>
  ${opts.nav ? nav(opts.theme, opts.nav) : ""}
  <main class="app-main">${opts.body}</main>
  ${footer()}
  <script src="/app.js" defer></script>
</body>
</html>`;
}
