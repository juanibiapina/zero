// In-memory AttachmentStore adapter for tests. Mirrors the R2 adapter's
// semantics: put/get round-trip bytes, deleteAllForUser drops everything under
// the user's prefix.

import {
  type AttachmentStore,
  userAttachmentPrefix,
} from "./types";

export const createMemoryAttachments = (): AttachmentStore => {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) {
      blobs.set(key, bytes);
    },
    async get(key) {
      return blobs.get(key) ?? null;
    },
    async deleteAllForUser(clerkUserId) {
      const prefix = userAttachmentPrefix(clerkUserId);
      for (const key of [...blobs.keys()]) {
        if (key.startsWith(prefix)) blobs.delete(key);
      }
    },
  };
};
