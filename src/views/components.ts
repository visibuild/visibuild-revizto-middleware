/**
 * views/components.ts – the small pieces every page reuses.
 *
 * Server-rendered strings, no framework. Anything that takes user or API data
 * escapes it here so the pages themselves stay readable.
 */
import { esc } from "./layout";

export interface PageMessage {
  kind: "success" | "error" | "info";
  text: string;
}

export function message(msg: PageMessage | undefined): string {
  if (!msg) return "";
  return `<div class="message ${msg.kind}">${esc(msg.text)}</div>`;
}

export function pageHeader(title: string, subtitle?: string, actions?: string): string {
  return `<div class="page-header ${actions ? "page-header--row" : ""}">
    <div>
      <h1 class="page-title">${esc(title)}</h1>
      ${subtitle ? `<p class="page-subtitle">${esc(subtitle)}</p>` : ""}
    </div>
    ${actions ? `<div class="header-actions">${actions}</div>` : ""}
  </div>`;
}

export function emptyState(title: string, body: string, action = ""): string {
  return `<div class="empty-state">
    <div class="empty-title">${esc(title)}</div>
    <div class="empty-body">${esc(body)}</div>
    ${action ? `<div style="margin-top:14px">${action}</div>` : ""}
  </div>`;
}

/** A label/value definition list. Values are pre-rendered HTML. */
export function definitionList(rows: [string, string][]): string {
  const items = rows
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${value}</dd>`)
    .join("");
  return `<dl class="detail-dl">${items}</dl>`;
}

export function sectionTitle(text: string, hint?: string): string {
  return `<p class="form-section-title">${esc(text)}</p>${
    hint ? `<p class="field-hint" style="margin:-6px 0 12px">${esc(hint)}</p>` : ""
  }`;
}

/** A `<select>` built from options, with one marked selected. */
export function select(
  name: string,
  options: { value: string; label: string; disabled?: boolean }[],
  selected: string,
  attrs: { id?: string; className?: string; autosubmit?: boolean } = {},
): string {
  const rendered = options
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${o.value === selected ? " selected" : ""}${
          o.disabled ? " disabled" : ""
        }>${esc(o.label)}</option>`,
    )
    .join("");
  return `<select name="${esc(name)}"${attrs.id ? ` id="${esc(attrs.id)}"` : ""}${
    attrs.className ? ` class="${esc(attrs.className)}"` : ""
  }${attrs.autosubmit ? " data-autosubmit" : ""}>${rendered}</select>`;
}

/** A checkbox with its label, as used throughout Settings. */
export function checkbox(name: string, label: string, checked: boolean, value = "1"): string {
  return `<label class="checkbox-item" style="cursor:pointer">
    <input type="checkbox" name="${esc(name)}" value="${esc(value)}"${checked ? " checked" : ""}>
    <span>${esc(label)}</span>
  </label>`;
}

/** A table, where every cell is already-escaped HTML. */
export function table(headers: string[], rows: string[][], className = "data-table"): string {
  if (rows.length === 0) return "";
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table class="${esc(className)}">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/** Render a value from the sync log compactly: arrays as lists, blanks as a dash. */
export function renderValue(value: unknown): string {
  if (value == null || value === "") return `<span class="text-muted">–</span>`;
  if (Array.isArray(value)) {
    return value.length ? value.map((v) => `<code>${esc(String(v))}</code>`).join(" ") : `<span class="text-muted">none</span>`;
  }
  if (typeof value === "object") return `<code>${esc(JSON.stringify(value))}</code>`;
  return `<code>${esc(String(value))}</code>`;
}
