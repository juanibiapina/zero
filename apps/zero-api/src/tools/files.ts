import { z } from "zod";
import { defineTool, type AgentToolSet } from "../agents/protocol";
import { ExternalCallNotSent, isProvableRejection } from "../agents/external-call";
import { fmtErr, log, logError } from "../log";
import type { ImageResizer } from "../images/types";
import { readPdfText, type PdfTextResult } from "../files/pdf";
import { renderFileMarker } from "../files/marker";
import type { StoredFile, UserFileStore } from "../files/types";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// A tool result is stored verbatim and replayed verbatim on every later turn,
// and a Durable Object SQLite row holds at most 2 MB, so an image the model
// sees must be an image the row can carry. `view_image` therefore hands over a
// viewing copy, not the original: anything above the threshold is resized, and
// what the model sees is exactly what gets stored.
//
// A 6.3 MB photo used to become ~8.4 MB of base64, which SQLite rejected with
// SQLITE_TOOBIG and killed every turn in the thread (2026-08-12). The original
// file is untouched and `send_file` still sends it at full size.
export const VIEW_IMAGE_RESIZE_THRESHOLD_BYTES = 1024 * 1024;
// Models downscale above ~1568 px on the long edge anyway, so anything larger
// costs bytes and tokens without adding detail.
export const VIEW_IMAGE_MAX_EDGE = 1568;
// Hard ceiling on what may leave this tool, base64 included (~4/3 of this),
// with generous headroom under the 2 MB row limit.
export const MAX_VIEW_IMAGE_BYTES = 1024 * 1024;

export class TelegramFileSendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TelegramFileSendError";
  }
}

export interface FileToolDeps {
  files?: UserFileStore;
  readPdf?: typeof readPdfText;
  sendFile?: (file: StoredFile, bytes: Uint8Array) => Promise<void>;
  // Absent in tests and wherever the Images binding is unavailable; a large
  // image is then refused rather than returned in a form nothing can store.
  resizer?: ImageResizer;
}

const metadata = (file: StoredFile) => ({
  id: file.id,
  filename: file.filename,
  mimeType: file.mimeType,
  byteSize: file.byteSize,
  createdAt: file.createdAt,
  marker: renderFileMarker(file),
});

// Chunked on purpose: appending one character at a time builds a multi-megabyte
// string byte by byte, which is real memory pressure inside a Durable Object.
const BASE64_CHUNK = 8192;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
};

const megabytes = (bytes: number): number =>
  Math.round((bytes / (1024 * 1024)) * 10) / 10;

type ViewOutput = { data: string; mediaType: string } | { error: string };
type PdfOutput = { text: string } | { error: string };

const formatPdfText = (filename: string, result: PdfTextResult): string => {
  const body = result.pages.map((page) => `--- Page ${page.page} ---\n${page.text}`).join("\n\n");
  const nextPage = result.endPage + 1;
  const more = result.truncated
    ? nextPage <= result.totalPages
      ? `\n\nMore pages are available. Call read_pdf with start_page=${nextPage}.`
      : "\n\nThe extracted text was truncated at the character limit. Read a smaller page range."
    : "";
  return `PDF ${JSON.stringify(filename)}, pages ${result.startPage}-${result.endPage} of ${result.totalPages} (text layer only; any images in these pages are not included)\n\n${body}${more}`;
};

export const buildFileTools = (deps: FileToolDeps): AgentToolSet => {
  const { files, readPdf = readPdfText, sendFile, resizer } = deps;

  const viewImage = defineTool({
    description:
      "View a stored image by file id. Resolve topic markers with get_file first. " +
      "Only JPEG, PNG, GIF, and WebP images are supported.",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }): Promise<ViewOutput> => {
      const file = files?.get(id);
      if (!file) return { error: `No file found for id ${id}.` };
      if (!IMAGE_MIME_TYPES.has(file.mimeType)) {
        return { error: `File ${id} is not a supported image.` };
      }
      const bytes = await files?.read(id);
      if (!bytes) return { error: `No file found for id ${id}.` };
      if (bytes.length <= VIEW_IMAGE_RESIZE_THRESHOLD_BYTES) {
        return { data: toBase64(bytes), mediaType: file.mimeType };
      }
      const tooLarge: ViewOutput = {
        error: `Image ${id} is too large to look at (${megabytes(bytes.length)} MB) and could not be resized.`,
      };
      if (!resizer) {
        logError("image_resize_failed", {
          reason: "resizer_unwired",
          byte_count: bytes.length,
        });
        return tooLarge;
      }
      const started = Date.now();
      try {
        const resized = await resizer.resize({ bytes, maxEdge: VIEW_IMAGE_MAX_EDGE });
        if (resized.bytes.length > MAX_VIEW_IMAGE_BYTES) {
          logError("image_resize_failed", {
            reason: "still_too_large",
            byte_count: bytes.length,
            resized_byte_count: resized.bytes.length,
          });
          return tooLarge;
        }
        log("image_resized", {
          byte_count: bytes.length,
          resized_byte_count: resized.bytes.length,
          duration_ms: Date.now() - started,
        });
        return { data: toBase64(resized.bytes), mediaType: resized.mimeType };
      } catch (error) {
        logError("image_resize_failed", {
          reason: "resizer_threw",
          byte_count: bytes.length,
          duration_ms: Date.now() - started,
          error: fmtErr(error),
        });
        return tooLarge;
      }
    },
    toContent: (raw: unknown) => {
      const output = raw as ViewOutput;
      return "error" in output
        ? { content: output.error, isError: true }
        : {
            content: [{
              type: "image" as const,
              source: { type: "base64" as const, media_type: output.mediaType, data: output.data },
            }],
          };
    },
  });

  return {
    get_file: defineTool({
      description: "Get stored file metadata and its canonical marker by id. Never returns file bytes.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const file = files?.get(id);
        return file ? { file: metadata(file) } : { error: `No file found for id ${id}.` };
      },
    }),
    list_files: defineTool({
      description:
        "List the user's stored files newest first. Search by safe filename or filter by an exact MIME type or major prefix such as image/*.",
      inputSchema: z.object({
        query: z.string().optional(),
        mime_type: z.string().optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      }),
      execute: async ({ query, mime_type, limit, cursor }) => {
        if (!files) return { error: "File storage is unavailable." };
        const page = files.list({ query, mimeType: mime_type, limit, cursor });
        return { files: page.files.map(metadata), nextCursor: page.nextCursor };
      },
    }),
    view_image: viewImage,
    // Compatibility for persisted tool calls from before the rename.
    view_attachment: viewImage,
    read_pdf: defineTool({
      description:
        "Read bounded, page-labelled text from a stored PDF by id. Text only: this returns the PDF's text layer and never its images, so it cannot tell you whether the PDF contains a photo or what one shows. Never conclude from this tool that a PDF has no picture. Page numbers are one-indexed and each call reads at most 20 pages.",
      inputSchema: z.object({
        id: z.string(),
        start_page: z.number().int().positive().optional(),
        end_page: z.number().int().positive().optional(),
      }),
      execute: async ({ id, start_page, end_page }): Promise<PdfOutput> => {
        const started = Date.now();
        const fail = (message: string, reason: string): PdfOutput => {
          logError("pdf_read_failed", { reason, error: fmtErr(new Error(message)) });
          return { error: message };
        };
        const file = files?.get(id);
        if (!file) return fail(`No file found for id ${id}.`, files ? "not_found" : "store_unwired");
        if (file.mimeType !== "application/pdf") return fail(`File ${id} is not a PDF.`, "wrong_mime");
        const bytes = await files?.read(id);
        if (!bytes) return fail(`No file found for id ${id}.`, "bytes_missing");
        try {
          const result = await readPdf(bytes, { startPage: start_page, endPage: end_page });
          return { text: formatPdfText(file.filename, result) };
        } catch (error) {
          const message = error instanceof Error ? error.message : "This PDF could not be read.";
          const lower = message.toLowerCase();
          const reason = lower.includes("password") || lower.includes("encrypted")
            ? "encrypted"
            : lower.includes("scanned") || lower.includes("image-only")
              ? "image_only"
              : lower.includes("page") ? "invalid_range" : "malformed";
          logError("pdf_read_failed", { reason, duration_ms: Date.now() - started, error: fmtErr(error) });
          return { error: message };
        }
      },
      toContent: (raw: unknown) => {
        const output = raw as PdfOutput;
        return "error" in output
          ? { content: output.error, isError: true }
          : { content: output.text };
      },
    }),
    send_file: defineTool({
      description:
        "Send a stored file to the active Telegram topic with its original safe filename. Only call after the user explicitly asks to send that file.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        if (!files || !sendFile) throw new ExternalCallNotSent(`No file found for id ${id}.`);
        const file = files.get(id);
        if (!file) throw new ExternalCallNotSent(`No file found for id ${id}.`);
        const bytes = await files.read(id);
        if (!bytes) throw new ExternalCallNotSent(`No file found for id ${id}.`);
        try {
          await sendFile(file, bytes);
          return { sent: true, file: metadata(file) };
        } catch (error) {
          if (error instanceof TelegramFileSendError && isProvableRejection(error.status)) {
            logError("file_send_failed", { reason: "provider_rejection", status: error.status });
            throw new ExternalCallNotSent(error.message);
          }
          logError("file_send_failed", { reason: "ambiguous_delivery" });
          throw error;
        }
      },
      externalWrite: true,
    }),
    delete_file: defineTool({
      description:
        "Permanently delete one stored file. Only call after explicit confirmation naming the file. Existing topic and conversation markers will become unresolved. Idempotent.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ deleted: await files?.delete(id) ?? false }),
    }),
  };
};
