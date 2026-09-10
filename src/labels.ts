/**
 * labels.ts – turning API vocabulary into something readable.
 *
 * Both the UI and the text this app writes into Revizto need the same wording,
 * so the rule lives here rather than being reimplemented on each side.
 */

/**
 * Values that naive title-casing gets wrong. Acronyms should stay capitalised
 * and "n_a" is a fraction, not two initials.
 */
const OVERRIDES: Record<string, string> = {
  ncr: "NCR",
  n_a: "N/A",
  cant_close: "Can't close",
};

/**
 * "in_progress" -> "In Progress", but "ncr" -> "NCR".
 *
 * Falls back to a dash for a missing value, so a table cell never renders empty.
 */
export function humanise(value: string | null | undefined): string {
  if (!value) return "—";
  const key = value.toLowerCase();
  if (OVERRIDES[key]) return OVERRIDES[key];
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
