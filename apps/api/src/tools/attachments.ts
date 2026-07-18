// view_attachment tool for the interface agent. A user message may reference an
// image by id via a marker ([image "cat.jpg" id=att_abc]). Image bytes never
// ride in the conversation history (they cost ~1,600 tokens every turn they are
// in context); instead the agent calls this tool with the id when it needs to
// see the image, and the bytes come back inside an intra-turn tool_result.
//
// toModelOutput returns a `file` content part so the AI SDK serializes it as a
// real Anthropic image block in the tool_result (verified against the pinned
// versions), not a stringified blob. Across turns only the marker persists, so
// a later reference re-fetches by id.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { log } from "../log";
import type { AttachmentStore } from "../attachments/types";
import type { Attachment } from "../store/types";

export interface AttachmentToolDeps {
  attachments: AttachmentStore;
  // Resolve an attachment id to its metadata row, scoped to this user's DO/R2.
  // A spoofed id from another user cannot resolve here (per-user DO isolation).
  getAttachment: (id: string) => Attachment | null;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

// Explicit output type: annotating execute keeps tool() inference from falling
// through to its no-input overload when a union result meets toModelOutput.
type ViewOutput =
  | { data: string; mediaType: string }
  | { error: string };

export const buildAttachmentTool = (deps: AttachmentToolDeps): ToolSet => {
  const { attachments, getAttachment } = deps;

  return {
    view_attachment: tool({
      description:
        "Fetch an image the user sent so you can see it. Messages reference " +
        'images by id with a marker like [image "cat.jpg" id=att_abc]; pass ' +
        "that id to view the image. Works for any image from earlier in the " +
        "conversation, not only the most recent.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }): Promise<ViewOutput> => {
        const record = getAttachment(id);
        const bytes = record ? await attachments.get(record.r2Key) : null;
        if (!record || !bytes) {
          log("view_attachment_miss", { id });
          return { error: `No attachment found for id ${id}.` };
        }
        log("view_attachment", { id, mime: record.mimeType });
        return { data: toBase64(bytes), mediaType: record.mimeType };
      },
      toModelOutput: ({ output }: { output: ViewOutput }) =>
        "error" in output
          ? { type: "error-text", value: output.error }
          : {
              type: "content",
              value: [
                {
                  type: "file",
                  data: { type: "data", data: output.data },
                  mediaType: output.mediaType,
                },
              ],
            },
    }),
  };
};
