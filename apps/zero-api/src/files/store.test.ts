import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memory";
import { createMemoryFileBlobs } from "./memory";
import { createUserFileStore } from "./store";
import { FileQuotaExceededError, FileTooLargeError, MAX_FILE_BYTES } from "./types";

const make = (user = "user_1") => {
  let tick = 0;
  const records = new MemoryStore(() => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`);
  const blobs = createMemoryFileBlobs();
  const files = createUserFileStore({ clerkUserId: user, records, blobs });
  return { files, records, blobs };
};

const bytes = (...values: number[]) => new Uint8Array(values);

describe("UserFileStore", () => {
  it("saves and reads a normalized file", async () => {
    const { files } = make();
    const file = await files.save({
      filename: "../ reports/../report.txt",
      mimeType: "Text/Plain; charset=utf-8",
      bytes: bytes(1, 2, 3),
    });

    expect(file.id).toMatch(/^file_[a-f0-9]{64}$/);
    expect(file.filename).toBe("report.txt");
    expect(file.mimeType).toBe("text/plain");
    expect(file.byteSize).toBe(3);
    expect(await files.read(file.id)).toEqual(bytes(1, 2, 3));
  });

  it("deduplicates identical normalized metadata and bytes", async () => {
    const { files } = make();
    const first = await files.save({ filename: "report.txt", mimeType: "text/plain", bytes: bytes(1) });
    const second = await files.save({ filename: "report.txt", mimeType: "TEXT/PLAIN", bytes: bytes(1) });
    expect(second).toEqual(first);
    expect(files.list({}).files).toHaveLength(1);
  });

  it("uses filename and MIME type as part of identity", async () => {
    const { files } = make();
    const first = await files.save({ filename: "a.txt", mimeType: "text/plain", bytes: bytes(1) });
    const renamed = await files.save({ filename: "b.txt", mimeType: "text/plain", bytes: bytes(1) });
    const retyped = await files.save({ filename: "a.txt", mimeType: "application/octet-stream", bytes: bytes(1) });
    expect(new Set([first.id, renamed.id, retyped.id])).toHaveLength(3);
  });

  it("puts bytes before inserting metadata", async () => {
    const { records, blobs } = make();
    let objectPresent = false;
    const checkingRecords = {
      putFile: (input: Parameters<MemoryStore["putFile"]>[0]) => {
        expect(objectPresent).toBe(true);
        return records.putFile(input);
      },
      getFile: records.getFile.bind(records),
      listFiles: records.listFiles.bind(records),
      updateFileSize: records.updateFileSize.bind(records),
      deleteFile: records.deleteFile.bind(records),
      deleteAllFiles: records.deleteAllFiles.bind(records),
    };
    const checkingBlobs = {
      ...blobs,
      put: async (key: string, value: Uint8Array, mime: string) => {
        await blobs.put(key, value, mime);
        objectPresent = true;
      },
    };
    const files = createUserFileStore({ clerkUserId: "user_1", records: checkingRecords, blobs: checkingBlobs });
    await files.save({ filename: "a.txt", mimeType: "text/plain", bytes: bytes(1) });
  });

  it("repairs a metadata row whose object is missing", async () => {
    const { files, records } = make();
    const saved = await files.save({ filename: "a.txt", mimeType: "text/plain", bytes: bytes(1, 2) });
    const { blobs } = make();
    const repairing = createUserFileStore({ clerkUserId: "user_1", records, blobs });
    const repaired = await repairing.save({ filename: "a.txt", mimeType: "text/plain", bytes: bytes(1, 2) });
    expect(repaired.id).toBe(saved.id);
    expect(await repairing.read(saved.id)).toEqual(bytes(1, 2));
  });

  it("rejects oversized files and invalid claimed PDFs", async () => {
    const { files } = make();
    await expect(files.save({ filename: "big", mimeType: "application/octet-stream", bytes: new Uint8Array(MAX_FILE_BYTES + 1) })).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(files.save({ filename: "fake.pdf", mimeType: "application/pdf", bytes: bytes(1, 2) })).rejects.toThrow("not a valid PDF");
  });

  it("backfills legacy sizes before enforcing the user quota", async () => {
    const { records, blobs } = make();
    records.putFile({ id: "att_old", storageKey: "attachments/user_1/old", filename: "old.bin", mimeType: "application/octet-stream", byteSize: null });
    const quotaBlobs = {
      ...blobs,
      head: async (key: string) => key.endsWith("/old")
        ? { size: 100 * 1024 * 1024 }
        : blobs.head(key),
    };
    const files = createUserFileStore({ clerkUserId: "user_1", records, blobs: quotaBlobs });
    await expect(files.save({ filename: "new.txt", mimeType: "text/plain", bytes: bytes(1) })).rejects.toBeInstanceOf(FileQuotaExceededError);
    expect(files.get("att_old")?.byteSize).toBe(100 * 1024 * 1024);
  });

  it("lists newest first with filtering and stable cursors", async () => {
    const { files } = make();
    await files.save({ filename: "old.txt", mimeType: "text/plain", bytes: bytes(1) });
    await files.save({ filename: "photo.png", mimeType: "image/png", bytes: bytes(2) });
    await files.save({ filename: "new.txt", mimeType: "text/plain", bytes: bytes(3) });
    const first = files.list({ limit: 1, mimeType: "text/*" });
    expect(first.files.map((file) => file.filename)).toEqual(["new.txt"]);
    const second = files.list({ limit: 1, mimeType: "text/*", cursor: first.nextCursor ?? undefined });
    expect(second.files.map((file) => file.filename)).toEqual(["old.txt"]);
    expect(files.list({ query: "photo" }).files[0].filename).toBe("photo.png");
  });

  it("keeps files when a referencing topic is deleted", async () => {
    const { files, records } = make();
    const file = await files.save({ filename: "kept.txt", mimeType: "text/plain", bytes: bytes(1) });
    const version = records.getKnowledgeVersion();
    const next = records.createTopic({
      expectedVersion: version,
      name: "Report",
      description: "report file",
      body: `[file id=${file.id} name="kept.txt" mime="text/plain"]`,
    });
    records.deleteTopic({ expectedVersion: next, name: "Report" });
    expect(await files.read(file.id)).toEqual(bytes(1));
  });

  it("keeps files when Telegram is unlinked", async () => {
    const { files, records } = make();
    records.linkTelegram("123");
    const file = await files.save({ filename: "kept.txt", mimeType: "text/plain", bytes: bytes(1) });
    records.unlinkTelegram();
    expect(await files.read(file.id)).toEqual(bytes(1));
  });

  it("isolates two users that save identical files into one bucket", async () => {
    const blobs = createMemoryFileBlobs();
    const first = createUserFileStore({ clerkUserId: "user_1", records: new MemoryStore(), blobs });
    const second = createUserFileStore({ clerkUserId: "user_2", records: new MemoryStore(), blobs });
    const input = { filename: "same.txt", mimeType: "text/plain", bytes: bytes(1) };
    const firstFile = await first.save(input);
    const secondFile = await second.save(input);
    expect(firstFile.id).toBe(secondFile.id);
    await first.deleteAll();
    expect(await first.read(firstFile.id)).toBeNull();
    expect(await second.read(secondFile.id)).toEqual(bytes(1));
  });

  it("deletes one file idempotently and bulk-deletes legacy and new objects", async () => {
    const { files, records, blobs } = make();
    const file = await files.save({ filename: "a.txt", mimeType: "text/plain", bytes: bytes(1) });
    expect(await files.delete(file.id)).toBe(true);
    expect(await files.delete(file.id)).toBe(false);

    records.putFile({ id: "att_old", storageKey: "attachments/user_1/old", filename: "old.bin", mimeType: "application/octet-stream", byteSize: null });
    await blobs.put("attachments/user_1/old", bytes(9), "application/octet-stream");
    await files.save({ filename: "b.txt", mimeType: "text/plain", bytes: bytes(2) });
    await files.deleteAll();
    expect(files.list({}).files).toEqual([]);
    expect(await blobs.get("attachments/user_1/old")).toBeNull();
  });

  // What makes deleteAll a complete erasure rather than a walk of the metadata:
  // an object whose row was lost (a save that died between put and insert, an
  // old bug) is invisible to a row-driven loop and would outlive the user.
  it("deletes objects the metadata no longer knows about", async () => {
    const { files, blobs } = make();
    await blobs.put("files/user_1/orphan", bytes(7), "text/plain");
    await blobs.put("attachments/user_1/orphan", bytes(8), "text/plain");
    await blobs.put("files/user_2/keep", bytes(9), "text/plain");

    await files.deleteAll();

    expect(await blobs.get("files/user_1/orphan")).toBeNull();
    expect(await blobs.get("attachments/user_1/orphan")).toBeNull();
    expect(await blobs.get("files/user_2/keep")).toEqual(bytes(9));
  });
});
