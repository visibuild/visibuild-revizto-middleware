/**
 * revizto/types.ts – the slice of the Revizto 5 API we write to and read back.
 *
 * See https://developer.revizto.com/docs/v5. Two things shape everything here:
 * an issue field is always `{ value, timestamp }`, and an edit is a diff of
 * `{ old, new }` pairs that Revizto silently drops if `old` is wrong.
 */

/** Revizto is deployed per region and regions are fully independent. */
export const REVIZTO_REGIONS = [
  { id: "sydney", label: "Australia", host: "https://api.sydney.revizto.com" },
  { id: "canada", label: "Canada", host: "https://api.canada.revizto.com" },
  { id: "shanghai", label: "China", host: "https://api.shanghai.revizto.com" },
  { id: "ireland", label: "Europe (Ireland)", host: "https://api.ireland.revizto.com" },
  { id: "london", label: "Europe (London)", host: "https://api.london.revizto.com" },
  { id: "tokyo", label: "Japan", host: "https://api.tokyo.revizto.com" },
  { id: "ksa", label: "Kingdom of Saudi Arabia", host: "https://api.ksa.revizto.com" },
  { id: "virginia", label: "North America (USA)", host: "https://api.virginia.revizto.com" },
  { id: "saopaulo", label: "South America (Brazil)", host: "https://api.saopaulo.revizto.com" },
  { id: "singapore", label: "Southeast Asia (Singapore)", host: "https://api.singapore.revizto.com" },
  { id: "zurich", label: "Switzerland", host: "https://api.zurich.revizto.com" },
  { id: "frankfurt", label: "UAE (hosted in Germany)", host: "https://api.frankfurt.revizto.com" },
] as const;

export type ReviztoRegion = (typeof REVIZTO_REGIONS)[number]["id"];

export function regionHost(region: string): string {
  return REVIZTO_REGIONS.find((r) => r.id === region)?.host ?? REVIZTO_REGIONS[0].host;
}

export function regionLabel(region: string): string {
  return REVIZTO_REGIONS.find((r) => r.id === region)?.label ?? region;
}

/** Revizto's fixed priority vocabulary. */
export const REVIZTO_PRIORITIES = ["blocker", "critical", "major", "minor", "trivial", "none"] as const;
export type ReviztoPriority = (typeof REVIZTO_PRIORITIES)[number];

/**
 * The issue fields this middleware manages. Every one of these can be set at
 * creation *and* changed later through a diff comment.
 *
 * Note what is missing: `locationPropertiesJson` is settable at creation only –
 * Revizto's diff vocabulary has no entry for it. That is why the location path
 * is also written as a tag by default, so a visi that moves still shows the
 * change on the Revizto side.
 */
export interface ManagedFields {
  title: string;
  customStatus: string; // status UUID
  customType: string; // type UUID
  assignee: string; // email
  reporter: string; // email
  deadline: string; // "YYYY-MM-DD HH:MM:SS", or "" for none
  priority: ReviztoPriority;
  tags: string[];
  visibility: number; // 0 private, 1 public
}

export const MANAGED_FIELD_KEYS = [
  "title",
  "customStatus",
  "customType",
  "assignee",
  "reporter",
  "deadline",
  "priority",
  "tags",
  "visibility",
] as const;

export type ManagedFieldKey = (typeof MANAGED_FIELD_KEYS)[number];

/** Human labels for the sync log and the mapping UI. */
export const MANAGED_FIELD_LABELS: Record<ManagedFieldKey, string> = {
  title: "Title",
  customStatus: "Status",
  customType: "Type",
  assignee: "Assignee",
  reporter: "Reporter",
  deadline: "Deadline",
  priority: "Priority",
  tags: "Tags",
  visibility: "Visibility",
};

/** Revizto's location tags. Settable when the issue is created only. */
export interface LocationProperties {
  level: string | null;
  room: string | null;
  area: string | null;
  zone: string | null;
  space: string | null;
}

export const LOCATION_FIELDS = ["level", "room", "area", "zone", "space"] as const;
export type LocationField = (typeof LOCATION_FIELDS)[number];

export interface ReviztoLicense {
  uuid: string;
  name: string;
  accountUuid: string | null;
}

export interface ReviztoProject {
  /** The integer id, required by issue/add and comment/add. */
  id: number;
  /** The UUID, required by workflows, team and issue queries. */
  uuid: string;
  title: string;
  archived: boolean;
}

export interface ReviztoMember {
  email: string;
  fullname: string;
  uuid: string | null;
  company: string | null;
  frozen: boolean;
}

export interface ReviztoIssueType {
  uuid: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  deleted: boolean;
  workflowUuid: string | null;
}

export interface ReviztoIssueStatus {
  uuid: string;
  name: string;
  /** "To do", "In progress", "Completed", … */
  category: string;
  deleted: boolean;
}

export interface ReviztoWorkflowSettings {
  types: ReviztoIssueType[];
  statuses: ReviztoIssueStatus[];
}

/** An issue as returned by the filter endpoint, reduced to the fields we manage. */
export interface ReviztoIssue {
  uuid: string;
  id: number | null;
  fields: Partial<ManagedFields>;
  updated: string | null;
}

/** Stored OAuth state. Lives under its own KV key so a Settings save can't clobber it. */
export interface ReviztoTokens {
  region: string;
  accessToken: string;
  /** Epoch seconds, computed from our clock at receipt. */
  accessTokenExpiresAt: number;
  refreshToken: string;
  /** Email of the Revizto user the sync acts as. */
  connectedEmail: string;
  connectedName: string;
  connectedAt: string;
  /** Set when a refresh has failed and the operator must reconnect. */
  needsReauth?: boolean;
  lastError?: string;
}
