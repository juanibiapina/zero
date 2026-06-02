import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { saveNotes } from "./save-notes.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveNotes", () => {
  it("does nothing when the directory does not exist", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await saveNotes("/nonexistent/path", "http://zero.worker", "user-1");

    expect(spy).not.toHaveBeenCalled();
  });

  it("does nothing when the directory is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await saveNotes(dir, "http://zero.worker", "user-1");

    expect(spy).not.toHaveBeenCalled();
  });

  it("archives and uploads when the directory has files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    writeFileSync(join(dir, "User.md"), "# Juan");

    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", spy);

    await saveNotes(dir, "http://zero.worker", "user-1");

    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: Buffer }];
    const [url, init] = call;
    expect(url).toBe("http://zero.worker/notes");
    expect(init.method).toBe("PUT");
    expect(init.headers["X-Clerk-User-Id"]).toBe("user-1");
    expect(init.headers["Content-Type"]).toBe("application/gzip");
    expect(init.body).toBeInstanceOf(Buffer);
    expect(init.body.length).toBeGreaterThan(0);
  });

  it("does not throw when upload fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    writeFileSync(join(dir, "User.md"), "# Juan");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 500 })));

    await expect(saveNotes(dir, "http://zero.worker", "user-1")).resolves.toBeUndefined();
  });

  it("does not throw when fetch throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    writeFileSync(join(dir, "User.md"), "# Juan");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(saveNotes(dir, "http://zero.worker", "user-1")).resolves.toBeUndefined();
  });
});
