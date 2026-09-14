// Bump this to invalidate every server-backed entity snapshot on mobile and web.
// The collections refill from their authoritative server lists.
export const ENTITY_CACHE_VERSION = 2;

// The outbox contains unsent writes, not cached data. Bump this only when a
// breaking mutation change intentionally discards every queued offline write.
export const OFFLINE_OUTBOX_VERSION = 2;
