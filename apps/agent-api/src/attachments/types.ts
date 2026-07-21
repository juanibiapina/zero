// Attachment blob store port (a true-external seam). The webhook and the
// view_attachment tool depend only on this interface; an R2 adapter serves
// production and an in-memory adapter serves tests. Bytes live here; SQLite
// holds only the metadata row and the message marker.

export interface AttachmentStore {
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  // Delete every object under a user's prefix. Wired into account
  // unlink/delete so a user's photos leave with their data.
  deleteAllForUser(clerkUserId: string): Promise<void>;
}

// Object key layout: per-user prefix so a user's files list and delete
// together; the file_unique_id component makes duplicate webhooks idempotent
// (same key, same bytes).
export const attachmentKey = (
  clerkUserId: string,
  fileUniqueId: string,
): string => `attachments/${clerkUserId}/${fileUniqueId}`;

// The prefix used by deleteAllForUser. Kept next to attachmentKey so the
// layout is defined in one place.
export const userAttachmentPrefix = (clerkUserId: string): string =>
  `attachments/${clerkUserId}/`;
