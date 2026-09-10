/**
 * visibuild/types.ts – the slice of the Visibuild Core API we read.
 *
 * Field names follow the published schema (camelCase); the parsers in
 * client.ts are tolerant of snake_case too, since the API has historically
 * served both. See https://app.apac.visibuild.com/api/docs/core/v1
 */

/** Visi categories, per the Core API schema. */
export const VISI_CATEGORIES = ["inspection", "issue", "task", "ncr", "defect"] as const;
export type VisiCategory = (typeof VISI_CATEGORIES)[number];

/** Visi statuses, per the Core API schema. */
export const VISI_STATUSES = ["open", "in_progress", "in_review", "closed", "n_a", "cant_close"] as const;
export type VisiStatus = (typeof VISI_STATUSES)[number];

/**
 * Visi types. The API documents this as an open string, so this list is only
 * used to seed the mapping UI – an unrecognised type still syncs, falling back
 * to the category mapping.
 */
export const VISI_TYPES = [
  "inspection",
  "task",
  "hold_point",
  "witness_point",
  "ncr",
  "incomplete_works",
  "defect",
  "observation",
] as const;

export interface Visi {
  id: string;
  isRoot: boolean;
  alias: string | null; // e.g. "VIS-1"
  title: string;
  description: string;
  type: string | null;
  subtypeId: string | null;
  category: string | null;
  status: string;
  projectId: string | null;
  locationId: string | null;
  defectRoundId: string | null;
  projectMilestoneId: string | null;
  assigneeId: string | null;
  assigneeType: string | null; // "ProjectUser" | "ProjectCompany"
  createdByProjectUserId: string | null;
  replacedByVisiId: string | null;
  projectAttachmentIds: string[];
  dueDate: string | null; // date, in the project's time zone
  holdPointSkippedAt: string | null;
  startedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
}

export interface Project {
  id: string;
  name: string;
  projectIdentifier: string | null;
  rootLocationId: string | null;
  address: string | null;
  active: boolean;
}

export interface Location {
  id: string;
  name: string;
  projectId: string | null;
}

/** A row of the location ancestor/descendant closure table. */
export interface LocationClosure {
  ancestorId: string;
  descendantId: string;
  depth: number;
  order: number;
}

export interface ProjectUser {
  id: string; // the ProjectUser id – this is what a visi's assigneeId refers to
  projectId: string | null;
  userId: string | null;
  projectCompanyId: string | null;
  active: boolean;
}

export interface ProjectCompany {
  id: string; // the ProjectCompany id – also a possible visi assigneeId
  projectId: string | null;
  companyId: string | null;
  active: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  active: boolean;
}

export interface Company {
  id: string;
  name: string;
}

export interface Tag {
  id: string;
  name: string;
  tagSetName: string | null;
  order: number;
}

export interface VisiTag {
  visiId: string;
  tagId: string;
}

export interface Subtype {
  id: string;
  name: string;
  visiCategory: string | null;
}

export interface Milestone {
  id: string;
  name: string;
  order: number;
}

export interface ProjectMilestone {
  id: string;
  projectId: string | null;
  milestoneId: string | null;
  archived: boolean;
}

export interface DefectRound {
  id: string;
  roundName: string;
}

export interface VisiRequirement {
  id: string;
  visiId: string;
  type: string; // short_answer | checkbox | attachment | date | multi_choice | numeric | signature | …
  order: number;
  title: string;
  value: string | null;
  choices: string[] | null;
  allowMultiple: boolean;
  values: string[] | null;
  updatedAt: string | null;
}

export interface ProjectAttachment {
  id: string;
  title: string;
  description: string;
  url: string;
  projectId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface VisiStatusChange {
  id: string;
  visiId: string;
  projectUserId: string | null;
  event: string;
  comment: string | null;
  statusBefore: string | null;
  statusAfter: string | null;
  timestamp: string | null;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  projectIds: string[];
  failureCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  /** Only ever present in the response to a create call. */
  secret?: string;
}
