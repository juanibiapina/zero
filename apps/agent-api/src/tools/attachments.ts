// view_attachment tool for the interface agent. A user message may reference an
// image by id via a marker ([image "cat.jpg" id=att_abc]). Image bytes never
// ride in the conversation history (they cost ~1,600 tokens every turn they are
// in context); instead the agent calls this tool with the id when it needs to
// see the image, and the bytes come back inside an intra-turn tool_result.
//
// `toContent` turns the tool's output into a native Anthropic image block
// inside the tool_result, not a stringified blob. Across turns only the marker
// persists, so a later reference re-fetches by id.

import { defineTool, type AgentToolSet } from "../agents/protocol";
import { z } from "zod";
import { fmtErr, log, logError } from "../log";
import type { AttachmentStore } from "../attachments/types";
import { readPdfText, type PdfTextResult } from "../attachments/pdf";
import type { Attachment } from "../store/types";

export interface AttachmentToolDeps {
  // Both optional so the tool can be registered unconditionally with a
  // byte-identical schema (needed for cross-user tool-cache sharing). When
  // either is absent the store is unwired and view_attachment returns an error.
  attachments?: AttachmentStore;
  // Resolve an attachment id to its metadata row, scoped to this user's DO/R2.
  // A spoofed id from another user cannot resolve here (per-user DO isolation).
  getAttachment?: (id: string) => Attachment | null;
  readPdf?: typeof readPdfText;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

// Explicit output type so toContent can narrow the union it is handed.
type ViewOutput =
  | { data: string; mediaType: string }
  | { error: string };

type PdfOutput = { text: string } | { error: string };

const formatPdfText = (filename: string, result: PdfTextResult): string => {
  const body = result.pages
    .map((page) => `--- Page ${page.page} ---\n${page.text}`)
    .join("\n\n");
  const nextPage = result.endPage + 1;
  const more = result.truncated
    ? nextPage <= result.totalPages
      ? `\n\nMore pages are available. Call read_pdf with start_page=${nextPage}.`
      : "\n\nThe extracted text was truncated at the character limit. Read a smaller page range."
    : "";
  return `PDF ${JSON.stringify(filename)}, pages ${result.startPage}-${result.endPage} of ${result.totalPages}\n\n${body}${more}`;
};

export const buildAttachmentTool = (deps: AttachmentToolDeps): AgentToolSet => {
  const { attachments, getAttachment, readPdf = readPdfText } = deps;

  return {
    view_attachment: defineTool({
      description:
        "Fetch an image the user sent so you can see it. Messages reference " +
        'images by id with a marker like [image "cat.jpg" id=att_abc]; pass ' +
        "that id to view the image. Works for any image from earlier in the " +
        "conversation, not only the most recent.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }): Promise<ViewOutput> => {
        if (!attachments || !getAttachment) {
          log("view_attachment_miss", { id, reason: "store_unwired" });
          return { error: `No attachment found for id ${id}.` };
        }
        const record = getAttachment(id);
        const bytes = record ? await attachments.get(record.r2Key) : null;
        if (!record || !bytes) {
          log("view_attachment_miss", { id });
          return { error: `No attachment found for id ${id}.` };
        }
        log("view_attachment", { id, mime: record.mimeType });
        return { data: toBase64(bytes), mediaType: record.mimeType };
      },
      toContent: (raw: unknown) => {
        const output = raw as ViewOutput;
        return "error" in output
          ? { content: output.error, isError: true }
          : {
              content: [
                {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: output.mediaType,
                    data: output.data,
                  },
                },
              ],
            };
      },
    }),
    read_pdf: defineTool({
      description:
        "Read text from a PDF the user sent. Messages reference PDFs by id " +
        'with a marker like [pdf "report.pdf" id=att_abc]. Pass that id and ' +
        "optionally a one-indexed page range. Read at most 20 pages per call; " +
        "use another call for later pages.",
      inputSchema: z.object({
        id: z.string(),
        start_page: z.number().int().positive().optional(),
        end_page: z.number().int().positive().optional(),
      }),
      execute: async ({ id, start_page, end_page }): Promise<PdfOutput> => {
        const started = Date.now();
        const fail = (message: string, reason: string): PdfOutput => {
          const error = new Error(message);
          error.name = reason;
          logError("pdf_read_failed", {
            attachment_id: id,
            reason,
            error: fmtErr(error),
          });
          return { error: message };
        };
        log("pdf_read_started", {
          attachment_id: id,
          start_page: start_page ?? 1,
          end_page: end_page ?? null,
        });
        try {
          if (!attachments || !getAttachment) {
            return fail(`No attachment found for id ${id}.`, "store_unwired");
          }
          const record = getAttachment(id);
          if (!record) return fail(`No attachment found for id ${id}.`, "not_found");
          if (record.mimeType !== "application/pdf") {
            return fail(`Attachment ${id} is not a PDF.`, "wrong_mime");
          }
          const bytes = await attachments.get(record.r2Key);
          if (!bytes) return fail(`No attachment found for id ${id}.`, "bytes_missing");
          const result = await readPdf(bytes, {
            startPage: start_page,
            endPage: end_page,
          });
          const characters = result.pages.reduce((total, page) => total + page.text.length, 0);
          log("pdf_read_completed", {
            attachment_id: id,
            total_pages: result.totalPages,
            pages_returned: result.pages.length,
            characters,
            truncated: result.truncated,
            duration_ms: Date.now() - started,
          });
          return { text: formatPdfText(record.filename, result) };
        } catch (error) {
          const message = error instanceof Error ? error.message : "This PDF could not be read.";
          const lower = message.toLowerCase();
          const reason = lower.includes("password") || lower.includes("encrypted")
            ? "encrypted"
            : lower.includes("scanned") || lower.includes("image-only")
              ? "image_only"
              : lower.includes("page")
                ? "invalid_range"
                : "malformed";
          return fail(message, reason);
        }
      },
      toContent: (raw: unknown) => {
        const output = raw as PdfOutput;
        return "error" in output
          ? { content: output.error, isError: true }
          : { content: output.text };
      },
    }),
  };
};
