import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memory";
import { createMemoryFileBlobs } from "../files/memory";
import { createUserFileStore } from "../files/store";
import { ExternalCallNotSent } from "../agents/external-call";
import {
  buildFileTools,
  MAX_VIEW_IMAGE_BYTES,
  TelegramFileSendError,
  VIEW_IMAGE_MAX_EDGE,
  VIEW_IMAGE_RESIZE_THRESHOLD_BYTES,
} from "./files";

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

  it("view_image resizes an image too large to store, and shows the model what it stores", async () => {
    const { files } = setup();
    const original = new Uint8Array(VIEW_IMAGE_RESIZE_THRESHOLD_BYTES + 1).fill(7);
    const saved = await files.save({ filename: "big.png", mimeType: "image/png", bytes: original });
    const resize = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" }));
    const tool = buildFileTools({ files, resizer: { resize } }).view_image;

    const output = await tool.execute({ id: saved.id });

    // Compared by length, not by value: a deep equality over a megabyte of
    // bytes costs seconds and times the test out.
    const call = resize.mock.calls[0]?.[0] as { bytes: Uint8Array; maxEdge: number };
    expect(call.bytes.length).toBe(original.length);
    expect(call.maxEdge).toBe(VIEW_IMAGE_MAX_EDGE);
    expect(tool.toContent?.(output)).toEqual({ content: [{
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AQID" },
    }] });
  });

  it("view_image leaves a small image alone", async () => {
    const { files } = setup();
    const saved = await files.save({ filename: "small.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    const resize = vi.fn();
    const output = await execute(buildFileTools({ files, resizer: { resize } }), "view_image", { id: saved.id });
    expect(resize).not.toHaveBeenCalled();
    expect(output).toEqual({ data: "AQID", mediaType: "image/png" });
  });

  it("view_image reports a failed resize instead of returning an unstorable image", async () => {
    const { files } = setup();
    const bytes = new Uint8Array(VIEW_IMAGE_RESIZE_THRESHOLD_BYTES + 1).fill(7);
    const saved = await files.save({ filename: "big.png", mimeType: "image/png", bytes });
    const resizer = { resize: async () => { throw new Error("decode failed"); } };
    const output = await execute(buildFileTools({ files, resizer }), "view_image", { id: saved.id });
    expect(output).toEqual({ error: `Image ${saved.id} is too large to look at (1 MB) and could not be resized.` });
  });

  it("view_image refuses a large image when no resizer is wired", async () => {
    const { files } = setup();
    const bytes = new Uint8Array(VIEW_IMAGE_RESIZE_THRESHOLD_BYTES + 1).fill(7);
    const saved = await files.save({ filename: "big.png", mimeType: "image/png", bytes });
    const output = await execute(buildFileTools({ files }), "view_image", { id: saved.id });
    expect(output).toEqual({ error: `Image ${saved.id} is too large to look at (1 MB) and could not be resized.` });
  });

  it("view_image refuses when even the resized image is too large to store", async () => {
    const { files } = setup();
    const bytes = new Uint8Array(VIEW_IMAGE_RESIZE_THRESHOLD_BYTES + 1).fill(7);
    const saved = await files.save({ filename: "big.png", mimeType: "image/png", bytes });
    const resizer = { resize: async () => ({ bytes: new Uint8Array(MAX_VIEW_IMAGE_BYTES + 1), mimeType: "image/jpeg" }) };
    const output = await execute(buildFileTools({ files, resizer }), "view_image", { id: saved.id });
    expect(output).toEqual({ error: `Image ${saved.id} is too large to look at (1 MB) and could not be resized.` });
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
