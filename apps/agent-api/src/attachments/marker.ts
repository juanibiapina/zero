// The text marker embedded in a user message when it carried an image. Only
// this marker persists across turns (image bytes are never in the transcript);
// the interface agent calls view_attachment with the id to see the image again.
// Format: [image "cat.jpg" id=att_abc]

export const renderAttachmentMarker = (a: {
  id: string;
  filename: string;
  kind?: "image" | "pdf";
}): string => `[${a.kind ?? "image"} "${a.filename}" id=${a.id}]`;
