import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { saveState } from "./save-state.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const populateWorkspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-"));
  mkdirSync(join(dir, "sessions", "abc"), { recursive: true });
  writeFileSync(join(dir, "sessions", "abc", "session.jsonl"), "{}\n");
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "User.md"), "# Juan");
  return dir;
};

describe("saveState", () => {
  it("does nothing when the directory does not exist", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await saveState("/nonexistent/path", "http://zero.worker", "user-1");

    expect(spy).not.toHaveBeenCalled();
  });

  it("does nothing when the directory is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-"));
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await saveState(dir, "http://zero.worker", "user-1");

    expect(spy).not.toHaveBeenCalled();
  });

  it("archives sessions and notes together and uploads to /state", async () => {
    const dir = populateWorkspace();

    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", spy);

    await saveState(dir, "http://zero.worker", "user-1");

    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: Buffer }];
    const [url, init] = call;
    expect(url).toBe("http://zero.worker/state");
    expect(init.method).toBe("PUT");
    expect(init.headers["X-Clerk-User-Id"]).toBe("user-1");
    expect(init.headers["Content-Type"]).toBe("application/gzip");
    expect(init.body).toBeInstanceOf(Buffer);
    expect(init.body.length).toBeGreaterThan(0);
  });

  it("does not throw when upload fails", async () => {
    const dir = populateWorkspace();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 500 })));

    await expect(saveState(dir, "http://zero.worker", "user-1")).resolves.toBeUndefined();
  });

  it("does not throw when fetch throws", async () => {
    const dir = populateWorkspace();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(saveState(dir, "http://zero.worker", "user-1")).resolves.toBeUndefined();
  });
});
