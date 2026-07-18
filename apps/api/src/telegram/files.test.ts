import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getFileSpy = vi.fn();

vi.mock("grammy", () => ({
  Bot: class {
    api = { getFile: getFileSpy };
  },
}));

import { downloadTelegramFile } from "./files";
import type { Env } from "../types";

const env = {
  TELEGRAM_BOT_TOKEN: "secret-token",
  TELEGRAM_API_ROOT: "https://api.telegram.org",
  TELEGRAM_BOT_INFO: JSON.stringify({ id: 1, is_bot: true, first_name: "bot", username: "bot" }),
} as unknown as Env;

describe("downloadTelegramFile", () => {
  beforeEach(() => {
    getFileSpy.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves file_path via getFile then fetches the bytes from the token URL", async () => {
    getFileSpy.mockResolvedValue({ file_path: "photos/file_1.jpg" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      );

    const result = await downloadTelegramFile(env, "FID");

    expect(getFileSpy).toHaveBeenCalledWith("FID");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.telegram.org/file/botsecret-token/photos/file_1.jpg",
    );
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.filePath).toBe("photos/file_1.jpg");
  });

  it("throws when the download response is not ok", async () => {
    getFileSpy.mockResolvedValue({ file_path: "photos/file_1.jpg" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 404 }),
    );

    await expect(downloadTelegramFile(env, "FID")).rejects.toThrow(
      "telegram file download failed: 404",
    );
  });
});
