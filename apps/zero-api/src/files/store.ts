import type { Settled } from "../awaitable";
import { log } from "../log";
import type { FileRecordStore } from "../store/types";
import {
  FileQuotaExceededError,
  FileTooLargeError,
  InvalidPdfError,
  MAX_FILE_BYTES,
  MAX_FILE_PAGE_SIZE,
  MAX_USER_FILE_BYTES,
  type FileBlobStore,
  type FileListInput,
  type FilePage,
  type StoredFile,
  type UserFileStore,
} from "./types";

const hasPdfSignature = (bytes: Uint8Array): boolean => {
  const end = Math.min(bytes.length - 4, 1020);
  for (let i = 0; i <= end; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2d
    ) return true;
  }
  return false;
};

export const normalizeFilename = (value: string): string => {
  const base = value.split(/[/\\]/).pop() ?? "";
  const printable = [...base]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("");
  const safe = printable.replace(/\.{2,}/g, ".").trim();
  return (safe || "file").slice(0, 255);
};

export const normalizeMimeType = (value: string): string => {
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    ? mime
    : "application/octet-stream";
};

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const fileId = async (
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<string> => {
  const metadata = new TextEncoder().encode(`${filename}\0${mimeType}\0`);
  const input = new Uint8Array(metadata.length + bytes.length);
  input.set(metadata);
  input.set(bytes, metadata.length);
  return `file_${hex(await crypto.subtle.digest("SHA-256", input))}`;
};

const encodeCursor = (file: StoredFile): string =>
  btoa(JSON.stringify([file.createdAt, file.id]));

const decodeCursor = (cursor: string): [string, string] | null => {
  try {
    const value: unknown = JSON.parse(atob(cursor));
    return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string")
      ? [value[0], value[1]]
      : null;
  } catch {
    return null;
  }
};

const beforeCursor = (file: StoredFile, cursor: [string, string]): boolean =>
  file.createdAt < cursor[0] ||
  (file.createdAt === cursor[0] && file.id < cursor[1]);

export const createUserFileStore = (input: {
  clerkUserId: string;
  records: FileRecordStore;
  blobs: FileBlobStore;
}): Settled<UserFileStore> => {
  const { clerkUserId, records, blobs } = input;
  const prefix = `files/${clerkUserId}/`;

  const hydrateSizes = async (): Promise<number> => {
    let total = 0;
    let unknown = 0;
    for (const file of records.listFiles()) {
      let size = file.byteSize;
      if (size === null) {
        unknown++;
        const object = await blobs.head(file.storageKey);
        size = object?.size ?? 0;
        if (object) records.updateFileSize(file.id, size);
      }
      total += size;
    }
    log("file_quota_measured", { file_count: records.listFiles().length, unknown_count: unknown, byte_total: total });
    return total;
  };

  return {
    async save(raw) {
      const started = Date.now();
      const filename = normalizeFilename(raw.filename);
      const mimeType = normalizeMimeType(raw.mimeType);
      const bytes = raw.bytes;
      if (bytes.length > MAX_FILE_BYTES) {
        log("file_save_failed", { reason: "size", byte_count: bytes.length, mime_major: mimeType.split("/")[0] });
        throw new FileTooLargeError();
      }
      if (mimeType === "application/pdf" && !hasPdfSignature(bytes)) {
        log("file_save_failed", { reason: "invalid_pdf", byte_count: bytes.length, mime_major: "application" });
        throw new InvalidPdfError();
      }
      const id = await fileId(filename, mimeType, bytes);
      const storageKey = `${prefix}${id}`;
      const existing = records.getFile(id);
      if (existing && await blobs.head(existing.storageKey)) {
        log("file_deduplicated", { byte_count: bytes.length, mime_major: mimeType.split("/")[0], duration_ms: Date.now() - started });
        return existing;
      }
      const total = await hydrateSizes();
      const existingSize = existing?.byteSize ?? 0;
      if (total - existingSize + bytes.length > MAX_USER_FILE_BYTES) {
        log("file_save_failed", {
          reason: "quota",
          byte_count: bytes.length,
          quota_bytes: total,
          attempted_quota_bytes: total - existingSize + bytes.length,
          mime_major: mimeType.split("/")[0],
        });
        throw new FileQuotaExceededError();
      }
      await blobs.put(existing?.storageKey ?? storageKey, bytes, mimeType);
      if (existing) {
        records.updateFileSize(id, bytes.length);
        log("file_repaired", { byte_count: bytes.length, mime_major: mimeType.split("/")[0], quota_bytes: total - existingSize + bytes.length, duration_ms: Date.now() - started });
        return { ...existing, byteSize: bytes.length };
      }
      const file = records.putFile({ id, storageKey, filename, mimeType, byteSize: bytes.length });
      log("file_saved", { byte_count: bytes.length, mime_major: mimeType.split("/")[0], quota_bytes: total + bytes.length, duration_ms: Date.now() - started });
      return file;
    },
    get(id) {
      return records.getFile(id);
    },
    async read(id) {
      const started = Date.now();
      const file = records.getFile(id);
      if (!file) return null;
      const bytes = await blobs.get(file.storageKey);
      log("file_read", {
        found: bytes !== null,
        ...(bytes ? {} : { reason: "missing_object" }),
        byte_count: bytes?.length ?? 0,
        mime_major: file.mimeType.split("/")[0],
        duration_ms: Date.now() - started,
      });
      return bytes;
    },
    list(raw: FileListInput): FilePage {
      const limit = Math.max(1, Math.min(raw.limit ?? 20, MAX_FILE_PAGE_SIZE));
      const query = raw.query?.trim().toLowerCase();
      const mime = raw.mimeType?.trim().toLowerCase();
      const cursor = raw.cursor ? decodeCursor(raw.cursor) : null;
      const matchesMime = (file: StoredFile) =>
        !mime || (mime.endsWith("/*") ? file.mimeType.startsWith(mime.slice(0, -1)) : file.mimeType === mime);
      const matches = records.listFiles()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .filter((file) => (!query || file.filename.toLowerCase().includes(query)) && matchesMime(file))
        .filter((file) => !cursor || beforeCursor(file, cursor));
      const files = matches.slice(0, limit);
      const nextCursor = matches.length > limit && files.length > 0
        ? encodeCursor(files[files.length - 1])
        : null;
      log("files_listed", { result_count: files.length, has_more: nextCursor !== null });
      return { files, nextCursor };
    },
    async delete(id) {
      const file = records.getFile(id);
      if (!file) return false;
      await blobs.delete(file.storageKey);
      records.deleteFile(id);
      log("file_deleted", { byte_count: file.byteSize ?? 0, mime_major: file.mimeType.split("/")[0] });
      return true;
    },
    async deleteAll() {
      for (const file of records.listFiles()) await blobs.delete(file.storageKey);
      await blobs.deletePrefix(`attachments/${clerkUserId}/`);
      await blobs.deletePrefix(prefix);
      records.deleteAllFiles();
    },
  };
};
