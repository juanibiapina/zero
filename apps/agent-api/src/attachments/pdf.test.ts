import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PDF_MAX_CHARACTERS, PdfReadError, readPdfText } from "./pdf";

const fixture = async (name: string) =>
  new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url).pathname));

describe("readPdfText", () => {
  it("extracts text in page order", async () => {
    const result = await readPdfText(await fixture("multi-page.pdf"));
    expect(result).toMatchObject({ totalPages: 3, startPage: 1, endPage: 3, truncated: false });
    expect(result.pages).toEqual([
      { page: 1, text: "First page text." },
      { page: 2, text: "Second page text." },
      { page: 3, text: "Third page text." },
    ]);
  });

  it("extracts an explicit page range", async () => {
    const result = await readPdfText(await fixture("multi-page.pdf"), { startPage: 2, endPage: 3 });
    expect(result.pages.map((page) => page.text)).toEqual(["Second page text.", "Third page text."]);
  });

  it("defaults to no more than 20 pages and reports later pages", async () => {
    const result = await readPdfText(await fixture("twenty-five-pages.pdf"));
    expect(result.pages).toHaveLength(20);
    expect(result.endPage).toBe(20);
    expect(result.truncated).toBe(true);
  });

  it("rejects ranges over 20 pages", async () => {
    await expect(readPdfText(await fixture("twenty-five-pages.pdf"), { startPage: 1, endPage: 21 }))
      .rejects.toThrow("Read at most 20 PDF pages");
  });

  it("caps extracted text at 30,000 characters", async () => {
    const result = await readPdfText(await fixture("long-text.pdf"));
    expect(result.pages.reduce((total, page) => total + page.text.length, 0)).toBeLessThanOrEqual(PDF_MAX_CHARACTERS);
    expect(result.truncated).toBe(true);
  });

  it("reports malformed PDFs with a stable error", async () => {
    await expect(readPdfText(await fixture("malformed.pdf"))).rejects.toEqual(
      new PdfReadError("This PDF is malformed or cannot be read."),
    );
  });

  it("reports encrypted PDFs with a stable error", async () => {
    await expect(readPdfText(await fixture("encrypted.pdf"))).rejects.toThrow(/encrypted|password-protected/i);
  });

  it("reports image-only PDFs separately", async () => {
    await expect(readPdfText(await fixture("image-only.pdf"))).rejects.toThrow(/scanned or image-only/i);
  });
});
