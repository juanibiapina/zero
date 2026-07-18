// R2 adapter for the AttachmentStore port. Stores attachment bytes in the
// ATTACHMENTS bucket. deleteAllForUser paginates the R2 list cursor so a user
// with many files is fully cleared.

import {
  type AttachmentStore,
  userAttachmentPrefix,
} from "./types";

export const createR2Attachments = (bucket: R2Bucket): AttachmentStore => ({
  async put(key, bytes, mimeType) {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: mimeType },
    });
  },
  async get(key) {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  },
  async deleteAllForUser(clerkUserId) {
    const prefix = userAttachmentPrefix(clerkUserId);
    let cursor: string | undefined;
    do {
      const listing = await bucket.list({ prefix, cursor });
      if (listing.objects.length > 0) {
        await bucket.delete(listing.objects.map((o) => o.key));
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  },
});
