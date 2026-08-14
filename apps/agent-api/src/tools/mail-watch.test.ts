import { describe, expect, it, vi } from "vitest";
import { buildMailWatchTools } from "./mail-watch";
import { createMailWatchBook } from "../mail-watch/book";
import { MemoryStore } from "../store/memory";

const makeTools = (options: { wired?: boolean; onWatchChanged?: () => void } = {}) => {
  const { wired = true } = options;
  const store = new MemoryStore(() => "2026-02-10T12:00:00.000Z");
  const conversationId = store.getOrCreateConversation(1, 0);
  const mailWatch = createMailWatchBook({ store, conversationId });
  const tools = buildMailWatchTools({
    mailWatch: wired ? mailWatch : undefined,
    onWatchChanged: options.onWatchChanged,
  });
  return { tools, store, conversationId };
};

type Exec<T> = (args: T) => Promise<unknown>;

const track = (tools: ReturnType<typeof buildMailWatchTools>, threadId: string) =>
  (tools.track_email_thread.execute as Exec<{ threadId: string }>)({ threadId });
const list = (tools: ReturnType<typeof buildMailWatchTools>) =>
  (tools.list_email_threads.execute as Exec<Record<string, never>>)({});
const untrack = (tools: ReturnType<typeof buildMailWatchTools>, threadId: string) =>
  (tools.untrack_email_thread.execute as Exec<{ threadId: string }>)({ threadId });

describe("mail watch tools", () => {
  it("tracks a thread and re-arms the poll", async () => {
    const onWatchChanged = vi.fn();
    const { tools, store } = makeTools({ onWatchChanged });
    await expect(track(tools, "T1")).resolves.toEqual({
      threadId: "T1",
      watchedSince: "2026-02-10T12:00:00.000Z",
      lastReplyAnnouncedAt: null,
    });
    expect(store.listMailThreads().map((t) => t.threadId)).toEqual(["T1"]);
    expect(onWatchChanged).toHaveBeenCalledOnce();
  });

  it("lists what is watched in this chat", async () => {
    const { tools } = makeTools();
    await track(tools, "T1");
    await expect(list(tools)).resolves.toEqual({
      threads: [
        {
          threadId: "T1",
          watchedSince: "2026-02-10T12:00:00.000Z",
          lastReplyAnnouncedAt: null,
        },
      ],
    });
  });

  it("untracks a watched thread and re-arms", async () => {
    const onWatchChanged = vi.fn();
    const { tools } = makeTools({ onWatchChanged });
    await track(tools, "T1");
    onWatchChanged.mockClear();
    await expect(untrack(tools, "T1")).resolves.toEqual({
      stopped: true,
      threadId: "T1",
    });
    await expect(list(tools)).resolves.toEqual({ threads: [] });
    expect(onWatchChanged).toHaveBeenCalledOnce();
  });

  it("reports an unwatched thread as an error rather than pretending", async () => {
    const { tools } = makeTools();
    expect(await untrack(tools, "nope")).toEqual({
      error: "That thread isn't being watched: nope.",
    });
  });

  it("stays registered but refuses without a book", async () => {
    const { tools } = makeTools({ wired: false });
    const refusal = { error: "Can't watch email threads in this context." };
    expect(await track(tools, "T1")).toEqual(refusal);
    expect(await list(tools)).toEqual(refusal);
    expect(await untrack(tools, "T1")).toEqual(refusal);
  });
});
