import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clampBashTimeout,
  createTimeoutBashOperations,
  writeAttachments,
} from "./session-bridge.js";

const OPTS = { defaultSecs: 300, maxSecs: 1800 };

const b64 = (...bytes: number[]) =>
  Buffer.from(Uint8Array.from(bytes)).toString("base64");

describe("clampBashTimeout", () => {
  it("applies the default when unset", () => {
    expect(clampBashTimeout(undefined, OPTS)).toBe(300);
  });

  it("applies the default for non-positive values", () => {
    expect(clampBashTimeout(0, OPTS)).toBe(300);
    expect(clampBashTimeout(-5, OPTS)).toBe(300);
  });

  it("passes through an in-range value", () => {
    expect(clampBashTimeout(120, OPTS)).toBe(120);
  });

  it("caps a value above the max", () => {
    expect(clampBashTimeout(5000, OPTS)).toBe(1800);
  });
});

describe("createTimeoutBashOperations", () => {
  it("forwards the clamped timeout to the base backend", async () => {
    const base = { exec: vi.fn().mockResolvedValue({ exitCode: 0 }) };
    const ops = createTimeoutBashOperations(base, () => {}, OPTS);

    await ops.exec("echo hi", "/tmp", { onData: () => {} });
    expect(base.exec).toHaveBeenCalledWith(
      "echo hi",
      "/tmp",
      expect.objectContaining({ timeout: 300 }),
    );

    await ops.exec("echo hi", "/tmp", { onData: () => {}, timeout: 9999 });
    expect(base.exec).toHaveBeenLastCalledWith(
      "echo hi",
      "/tmp",
      expect.objectContaining({ timeout: 1800 }),
    );
  });

  it("reports a timeout error once and re-throws it", async () => {
    const base = {
      exec: vi.fn().mockRejectedValue(new Error("timeout:300")),
    };
    const onTimeout = vi.fn();
    const ops = createTimeoutBashOperations(base, onTimeout, OPTS);

    await expect(
      ops.exec("sleep 999", "/tmp", { onData: () => {} }),
    ).rejects.toThrow("timeout:300");
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not call onTimeout for non-timeout errors", async () => {
    const base = { exec: vi.fn().mockRejectedValue(new Error("boom")) };
    const onTimeout = vi.fn();
    const ops = createTimeoutBashOperations(base, onTimeout, OPTS);

    await expect(
      ops.exec("bad", "/tmp", { onData: () => {} }),
    ).rejects.toThrow("boom");
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

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
