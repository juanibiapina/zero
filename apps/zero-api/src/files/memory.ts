import type { FileBlobStore } from "./types";

export const createMemoryFileBlobs = (): FileBlobStore => {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) {
      blobs.set(key, bytes.slice());
    },
    async get(key) {
      const bytes = blobs.get(key);
      return bytes?.slice() ?? null;
    },
    async head(key) {
      const bytes = blobs.get(key);
      return bytes ? { size: bytes.length } : null;
    },
    async delete(key) {
      blobs.delete(key);
    },
    async deletePrefix(prefix) {
      for (const key of blobs.keys()) {
        if (key.startsWith(prefix)) blobs.delete(key);
      }
    },
  };
};
