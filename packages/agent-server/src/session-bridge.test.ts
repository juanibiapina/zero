import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeAttachments } from "./session-bridge.js";

const b64 = (...bytes: number[]) =>
  Buffer.from(Uint8Array.from(bytes)).toString("base64");

describe("writeAttachments", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attachments-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes bytes to the attachments dir under the given filename", () => {
    const written = writeAttachments(dir, [
      { filename: "hello.txt", mimeType: "text/plain", dataBase64: b64(72, 105) },
    ]);

    expect(written).toEqual([
      { path: join(dir, "hello.txt"), mimeType: "text/plain" },
    ]);
    expect(readFileSync(written[0].path)).toEqual(Buffer.from([72, 105]));
  });

  it("sanitizes path-traversal filenames to a basename", () => {
    const written = writeAttachments(dir, [
      { filename: "../../etc/passwd", mimeType: "text/plain", dataBase64: b64(1) },
    ]);

    expect(written[0].path).toBe(join(dir, "passwd"));
  });

  it("resolves a name collision with a prefixed second file", () => {
    const written = writeAttachments(dir, [
      { filename: "a.bin", mimeType: "application/octet-stream", dataBase64: b64(1) },
      { filename: "a.bin", mimeType: "application/octet-stream", dataBase64: b64(2) },
    ]);

    expect(written[0].path).toBe(join(dir, "a.bin"));
    expect(written[1].path).not.toBe(written[0].path);
    expect(written[1].path.endsWith("_a.bin")).toBe(true);
    expect(readFileSync(written[0].path)).toEqual(Buffer.from([1]));
    expect(readFileSync(written[1].path)).toEqual(Buffer.from([2]));
  });
});
