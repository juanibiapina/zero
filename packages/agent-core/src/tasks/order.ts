// The manual-order sort key for the task list: a fractional index. To move a row
// between two neighbors, mint one key strictly between their keys — an O(1)
// write that touches only the moved row, never a renumber. The library is
// hidden behind this one tested seam for derived client lists. The canonical
// TinyBase model owns persisted Task projection order.
//
// Ported from the former captures/order.ts in the single-list merge; the Task
// list is now the sole consumer.

import { TodoModel } from "../taskdo/model";

// A key strictly between `a` and `b`. Pass null for `a` to mint at the head
// (before the first row) and null for `b` to mint at the tail (after the last
// row); both null mints the very first key. Keys are base-62 strings sorted by
// raw codepoint — never localeCompare, which folds case and corrupts the order.
export function orderKeyBetween(a: string | null, b: string | null): string {
  return TodoModel.orderKeyBetween(a, b);
}

// Compare two sort keys (nulls last) with the createdAt string as the tiebreak.
// Exported so homeTasks, upcomingSections and any future consumer order rows
// identically to the server. sortKey is compared by raw codepoint; createdAt
// (ISO, digit-only) keeps localeCompare.
export function compareByOrder(
  a: { sortKey: string | null; createdAt: string },
  b: { sortKey: string | null; createdAt: string },
): number {
  return TodoModel.compareTasks(a, b);
}
