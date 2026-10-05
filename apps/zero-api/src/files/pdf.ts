import { getDocumentProxy } from "unpdf";

export const PDF_MAX_PAGES = 20;
export const PDF_MAX_CHARACTERS = 30_000;

export interface PdfPageText {
  page: number;
  text: string;
}

export interface PdfTextResult {
  totalPages: number;
  startPage: number;
  endPage: number;
  pages: PdfPageText[];
  truncated: boolean;
}

export class PdfReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfReadError";
  }
}

const classifyPdfError = (error: unknown): PdfReadError => {
  const value = error as { name?: string; message?: string; code?: number };
  const detail = `${value.name ?? ""} ${value.message ?? String(error)}`.toLowerCase();
  if (
    value.name === "PasswordException" ||
    value.code === 1 ||
    value.code === 2 ||
    detail.includes("password") ||
    detail.includes("encrypted")
  ) {
    return new PdfReadError("This PDF is encrypted or password-protected and cannot be read.");
  }
  return new PdfReadError("This PDF is malformed or cannot be read.");
};

const pageText = async (document: Awaited<ReturnType<typeof getDocumentProxy>>, pageNumber: number) => {
  const page = await document.getPage(pageNumber);
  try {
    const content = await page.getTextContent();
    return content.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    page.cleanup();
  }
};

export const readPdfText = async (
  bytes: Uint8Array,
  range: { startPage?: number; endPage?: number } = {},
): Promise<PdfTextResult> => {
  const requestedStart = range.startPage ?? 1;
  if (!Number.isInteger(requestedStart) || requestedStart < 1) {
    throw new PdfReadError("PDF page numbers must be positive whole numbers.");
  }
  if (range.endPage !== undefined && (!Number.isInteger(range.endPage) || range.endPage < requestedStart)) {
    throw new PdfReadError("The PDF end page must be at or after the start page.");
  }
  const requestedEnd = range.endPage ?? requestedStart + PDF_MAX_PAGES - 1;
  if (requestedEnd - requestedStart + 1 > PDF_MAX_PAGES) {
    throw new PdfReadError(`Read at most ${PDF_MAX_PAGES} PDF pages at a time.`);
  }

  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    document = await getDocumentProxy(bytes);
    if (requestedStart > document.numPages) {
      throw new PdfReadError(`This PDF has only ${document.numPages} pages.`);
    }
    const endPage = Math.min(requestedEnd, document.numPages);
    const pages: PdfPageText[] = [];
    let remaining = PDF_MAX_CHARACTERS;
    let textTruncated = false;

    for (let page = requestedStart; page <= endPage; page += 1) {
      const text = await pageText(document, page);
      if (text.length > remaining) {
        // Stop before this page when earlier pages already produced useful text,
        // so the caller can resume at this page without losing its tail. A
        // single page over the cap has no finer page seam, so return its prefix.
        if (pages.length === 0) pages.push({ page, text: text.slice(0, remaining) });
        remaining = 0;
        textTruncated = true;
        break;
      }
      pages.push({ page, text });
      remaining -= text.length;
    }

    if (!pages.some((page) => page.text.trim().length > 0)) {
      throw new PdfReadError("No extractable text was found in these pages. The PDF may be scanned or image-only, and only its text layer can be read.");
    }

    return {
      totalPages: document.numPages,
      startPage: requestedStart,
      endPage: pages.at(-1)?.page ?? endPage,
      pages,
      truncated: textTruncated || endPage < document.numPages,
    };
  } catch (error) {
    if (error instanceof PdfReadError) throw error;
    throw classifyPdfError(error);
  } finally {
    if (document) {
      try {
        await document.cleanup();
      } finally {
        await document.loadingTask.destroy();
      }
    }
  }
};
