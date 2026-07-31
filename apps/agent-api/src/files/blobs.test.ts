import { describe, expect, it } from "vitest";
import { createMemoryFileBlobs } from "./memory";
import { createR2FileBlobs } from "./r2";
import type { FileBlobStore } from "./types";

const fakeBucket = () => {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
      store.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const entry = store.get(key);
      return entry ? { arrayBuffer: async () => entry.bytes.slice().buffer } : null;
    },
    async head(key: string) {
      const entry = store.get(key);
      return entry ? { size: entry.bytes.length } : null;
    },
    async list({ prefix, cursor }: { prefix?: string; cursor?: string }) {
      const keys = [...store.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .filter((key) => !cursor || key > cursor)
        .sort();
      const page = keys.slice(0, 2);
      return {
        objects: page.map((key) => ({ key })),
        truncated: keys.length > 2,
        cursor: keys.length > 2 ? page[page.length - 1] : undefined,
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
  };
};

const contract = (name: string, make: () => FileBlobStore) => {
  describe(name, () => {
    it("round-trips, heads, and deletes bytes", async () => {
      const blobs = make();
      await blobs.put("files/user_1/a", new Uint8Array([1, 2, 3]), "text/plain");
      expect(await blobs.head("files/user_1/a")).toEqual({ size: 3 });
      expect(await blobs.get("files/user_1/a")).toEqual(new Uint8Array([1, 2, 3]));
      await blobs.delete("files/user_1/a");
      expect(await blobs.get("files/user_1/a")).toBeNull();
    });

    it("deletes every paginated object under one prefix only", async () => {
      const blobs = make();
      for (let index = 0; index < 5; index++) {
        await blobs.put(`files/user_1/${index}`, new Uint8Array([index]), "application/octet-stream");
      }
      await blobs.put("files/user_2/keep", new Uint8Array([9]), "application/octet-stream");
      await blobs.deletePrefix("files/user_1/");
      for (let index = 0; index < 5; index++) {
        expect(await blobs.get(`files/user_1/${index}`)).toBeNull();
      }
      expect(await blobs.get("files/user_2/keep")).toEqual(new Uint8Array([9]));
    });
  });
};

contract("memory file blobs", createMemoryFileBlobs);
contract("R2 file blobs", () => createR2FileBlobs(fakeBucket() as unknown as R2Bucket));
