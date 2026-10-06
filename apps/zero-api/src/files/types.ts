import type { Awaitable } from "../awaitable";

// Zero's one file-size cap, shared by every path a file can take: Telegram
// uploads, Gmail attachments, Drive imports and uploads, and the store itself.
// Telegram's Bot API refuses to serve any file over 20 MB through getFile,
// which is why the cap is not higher; Drive could hand over more.
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_LABEL = `${MAX_FILE_BYTES / (1024 * 1024)} MB`;
export const MAX_USER_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_FILE_PAGE_SIZE = 50;

export interface StoredFile {
  id: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  byteSize: number | null;
  createdAt: string;
}

export interface FileListInput {
  query?: string;
  mimeType?: string;
  limit?: number;
  cursor?: string;
}

export interface FilePage {
  files: StoredFile[];
  nextCursor: string | null;
}

export interface UserFileStore {
  save(input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<StoredFile>;
  get(id: string): Awaitable<StoredFile | null>;
  read(id: string): Promise<Uint8Array | null>;
  list(input: FileListInput): Awaitable<FilePage>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

// Internal seam. R2 and memory adapters both satisfy it; callers outside this
// module never see object keys.
export interface FileBlobStore {
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export class FileTooLargeError extends Error {
  constructor() {
    super(`That file is too large (over ${MAX_FILE_LABEL}).`);
    this.name = "FileTooLargeError";
  }
}

export class FileQuotaExceededError extends Error {
  constructor() {
    super("Saving that file would exceed your 100 MB file storage limit.");
    this.name = "FileQuotaExceededError";
  }
}

export class InvalidPdfError extends Error {
  constructor() {
    super("That file is not a valid PDF.");
    this.name = "InvalidPdfError";
  }
}
