import type { FileBlobStore } from "./types";

export const createR2FileBlobs = (bucket: R2Bucket): FileBlobStore => ({
  async put(key, bytes, mimeType) {
    await bucket.put(key, bytes, { httpMetadata: { contentType: mimeType } });
  },
  async get(key) {
    const object = await bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  },
  async head(key) {
    const object = await bucket.head(key);
    return object ? { size: object.size } : null;
  },
  async delete(key) {
    await bucket.delete(key);
  },
  async deletePrefix(prefix) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor });
      if (page.objects.length > 0) {
        await bucket.delete(page.objects.map((object) => object.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  },
});
