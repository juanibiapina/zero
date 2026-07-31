import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memory";
import { createMemoryFileBlobs } from "../files/memory";
import { createUserFileStore } from "../files/store";
import { ExternalCallNotSent } from "../agents/external-call";
import { buildFileTools, TelegramFileSendError } from "./files";

const setup = () => {
  const files = createUserFileStore({
    clerkUserId: "user_1",
    records: new MemoryStore(),
    blobs: createMemoryFileBlobs(),
  });
  return { files };
};

const execute = (tools: ReturnType<typeof buildFileTools>, name: string, input: unknown) =>
  tools[name].execute(input);

describe("file tools", () => {
  it("gets and lists metadata with canonical markers but no bytes", async () => {
    const { files } = setup();
    const saved = await files.save({ filename: "notes.txt", mimeType: "text/plain", bytes: new Uint8Array([1, 2, 3]) });
    const tools = buildFileTools({ files });
    const got = await execute(tools, "get_file", { id: saved.id });
    const listed = await execute(tools, "list_files", { query: "notes", mime_type: "text/*" });
    const gotFile = (got as { file: { id: string; marker: string } }).file;
    const listedFiles = (listed as { files: Array<{ id: string }> }).files;
    expect(gotFile.id).toBe(saved.id);
    expect(gotFile.marker).toContain(`[file id=${saved.id}`);
    expect(listedFiles).toEqual([{ id: saved.id, filename: "notes.txt", mimeType: "text/plain", byteSize: 3, createdAt: saved.createdAt, marker: gotFile.marker }]);
    expect(JSON.stringify({ got, listed })).not.toContain("AQID");
  });

  it("view_image rejects non-images before reading them", async () => {
    const { files } = setup();
    const saved = await files.save({ filename: "notes.txt", mimeType: "text/plain", bytes: new Uint8Array([1]) });
    const output = await execute(buildFileTools({ files }), "view_image", { id: saved.id });
    expect(output).toEqual({ error: `File ${saved.id} is not a supported image.` });
  });

  it("view_image returns native image content through toContent", async () => {
    const { files } = setup();
    const saved = await files.save({ filename: "photo.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    const tool = buildFileTools({ files }).view_image;
    const output = await tool.execute({ id: saved.id });
    expect(tool.toContent?.(output)).toEqual({ content: [{
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AQID" },
    }] });
  });

  it("send_file sends original metadata and classifies definite rejection", async () => {
    const { files } = setup();
    const saved = await files.save({ filename: "notes.txt", mimeType: "text/plain", bytes: new Uint8Array([1]) });
    const sendFile = vi.fn(async () => {});
    const tools = buildFileTools({ files, sendFile });
    expect(tools.send_file.externalWrite).toBe(true);
    await execute(tools, "send_file", { id: saved.id });
    expect(sendFile).toHaveBeenCalledWith(expect.objectContaining({ filename: "notes.txt" }), new Uint8Array([1]));

    const rejected = buildFileTools({ files, sendFile: async () => { throw new TelegramFileSendError(400, "bad file"); } });
    await expect(execute(rejected, "send_file", { id: saved.id })).rejects.toBeInstanceOf(ExternalCallNotSent);
    const uncertain = buildFileTools({ files, sendFile: async () => { throw new Error("timeout"); } });
    await expect(execute(uncertain, "send_file", { id: saved.id })).rejects.toThrow("timeout");
  });

  it("delete_file is idempotent", async () => {
    const { files } = setup();
    const saved = await files.save({ filename: "notes.txt", mimeType: "text/plain", bytes: new Uint8Array([1]) });
    const tools = buildFileTools({ files });
    expect(await execute(tools, "delete_file", { id: saved.id })).toEqual({ deleted: true });
    expect(await execute(tools, "delete_file", { id: saved.id })).toEqual({ deleted: false });
  });
});
