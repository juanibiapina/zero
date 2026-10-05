import type { StoredFile } from "./types";

export const renderFileMarker = (
  file: Pick<StoredFile, "id" | "filename" | "mimeType">,
): string =>
  `[file id=${file.id} name=${JSON.stringify(file.filename)} mime=${JSON.stringify(file.mimeType)}]`;
