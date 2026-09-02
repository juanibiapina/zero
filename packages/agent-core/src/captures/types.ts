// A Capture: one raw, untyped line dropped into Captures. The single shared
// entity type for the Capture data layer, used by web and mobile.
export type Capture = {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
  // Local day (YYYY-MM-DD) the capture reappears on, or null for a plain,
  // always-visible capture. Postpone sets it.
  showUpDate: string | null;
  // Fractional-index sort key for the manual list order, or null (unkeyed,
  // sorts last — newest-at-bottom). In practice a keyed row is the norm (the
  // server mints the trailing key on add, reorder sets it, an init backfill keys
  // legacy rows); null is a legitimate transient state — the client's optimistic
  // just-added row before the server assigns its key on reconcile, or a legacy
  // server row before its backfill. Ordering tolerates null on both sides.
  sortKey: string | null;
};
