import { describe, expect, it } from "vitest";
import { createMemoryAttachments } from "./memory";
import { createR2Attachments } from "./r2";
import { attachmentKey } from "./types";

// Minimal fake R2Bucket: enough surface for put/get/list/delete. list()
// paginates in pages of two so the adapter's cursor loop is exercised.
const fakeBucket = () => {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    store,
    async put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      return { arrayBuffer: async () => entry.bytes.buffer };
    },
    async list({ prefix, cursor }: { prefix?: string; cursor?: string }) {
      // Key-based cursor (like R2): the next page starts after the last key
      // returned, so deleting listed keys between pages does not skip others.
      const keys = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .filter((k) => !cursor || k > cursor)
        .sort();
      const page = keys.slice(0, 2);
      const truncated = keys.length > 2;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
};

const runContract = (name: string, make: () => ReturnType<typeof createMemoryAttachments>) => {
  describe(name, () => {
    it("round-trips bytes through put/get", async () => {
      const store = make();
      const key = attachmentKey("user_1", "abc");
      await store.put(key, new Uint8Array([1, 2, 3]), "image/png");
      expect(await store.get(key)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("returns null for a missing key", async () => {
      const store = make();
      expect(await store.get("attachments/user_1/missing")).toBeNull();
    });

    it("deleteAllForUser removes only that user's objects", async () => {
      const store = make();
      // Five objects for user_1 forces multiple list pages in the fake bucket.
      for (let i = 0; i < 5; i++) {
        await store.put(attachmentKey("user_1", `f${i}`), new Uint8Array([i]), "image/png");
      }
      await store.put(attachmentKey("user_2", "keep"), new Uint8Array([9]), "image/png");

      await store.deleteAllForUser("user_1");

      for (let i = 0; i < 5; i++) {
        expect(await store.get(attachmentKey("user_1", `f${i}`))).toBeNull();
      }
      expect(await store.get(attachmentKey("user_2", "keep"))).toEqual(
        new Uint8Array([9]),
      );
    });
  });
};

runContract("memory attachments", () => createMemoryAttachments());
runContract("r2 attachments", () =>
  createR2Attachments(fakeBucket() as unknown as R2Bucket),
);
