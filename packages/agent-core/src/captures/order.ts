// The manual-order sort key for Captures: a fractional index. To move a row
// between two neighbors, mint one key strictly between their keys — an O(1)
// write that touches only the moved row, never a renumber. The library is
// hidden behind this one tested seam so both UIs (and the server, via its own
// import) share a single dependency surface.

import { generateKeyBetween } from "fractional-indexing";

// A key strictly between `a` and `b`. Pass null for `a` to mint at the head
// (before the first row) and null for `b` to mint at the tail (after the last
// row); both null mints the very first key. Keys are base-62 strings sorted by
// raw codepoint — never localeCompare, which folds case and corrupts the order.
export function orderKeyBetween(
  a: string | null,
  b: string | null,
): string {
  return generateKeyBetween(a, b);
}

// Compare two sort keys (nulls last) with the createdAt string as the tiebreak.
// Exported so visibleCaptures and any future consumer order rows identically to
// the server. sortKey is compared by raw codepoint; createdAt (ISO, digit-only)
// keeps localeCompare.
export function compareByOrder(
  a: { sortKey: string | null; createdAt: string },
  b: { sortKey: string | null; createdAt: string },
): number {
  if (a.sortKey == null && b.sortKey == null) {
    return a.createdAt.localeCompare(b.createdAt);
  }
  if (a.sortKey == null) return 1;
  if (b.sortKey == null) return -1;
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}
