/**
 * sync/mapping-types.ts – the type-only surface `mapping.ts` needs.
 *
 * Kept apart from `revizto/client.ts` so the mapping module stays free of any
 * import that reaches for `fetch`, and can be unit-tested on its own.
 */
export {
  LOCATION_FIELDS,
  MANAGED_FIELD_KEYS,
  MANAGED_FIELD_LABELS,
  REVIZTO_PRIORITIES,
} from "../revizto/types";
export type {
  LocationField,
  LocationProperties,
  ManagedFieldKey,
  ManagedFields,
  ReviztoPriority,
} from "../revizto/types";

/** `{old, new}` pairs, keyed by managed field – the body of a `diff` comment. */
export type FieldDiffInput = Partial<Record<import("../revizto/types").ManagedFieldKey, { old: unknown; new: unknown }>>;
