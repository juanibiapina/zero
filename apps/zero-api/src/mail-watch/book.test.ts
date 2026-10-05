import { describe, expect, it } from "vitest";
import { createMailWatchBook } from "./book";
import { MAX_WATCHED_THREADS } from "../do/mail-watch";
import { MemoryStore } from "../store/memory";

const setup = () => {
  const store = new MemoryStore(() => "2026-02-10T12:00:00.000Z");
  const conversationId = store.getOrCreateConversation(1, 0);
  return { store, book: createMailWatchBook({ store, conversationId }), conversationId };
};

describe("MailWatchBook", () => {
  it("watch stores the thread and list reports it", () => {
    const { book } = setup();
    expect(book.watch("T1")).toEqual({
      thread: {
        threadId: "T1",
        createdAt: "2026-02-10T12:00:00.000Z",
        lastNotifiedAt: null,
      },
    });
    expect(book.list().map((t) => t.threadId)).toEqual(["T1"]);
  });

  it("watching the same thread twice is not an error and does not duplicate", () => {
    const { book } = setup();
    book.watch("T1");
    expect(book.watch("T1")).toMatchObject({ thread: { threadId: "T1" } });
    expect(book.list()).toHaveLength(1);
  });

  it("list only reports threads watched in this conversation", () => {
    const { store, book } = setup();
    const other = store.getOrCreateConversation(2, 0);
    store.trackMailThread({ threadId: "elsewhere", conversationId: other });
    book.watch("here");
    expect(book.list().map((t) => t.threadId)).toEqual(["here"]);
  });

  it("stop reports whether the thread was being watched", () => {
    const { book } = setup();
    book.watch("T1");
    expect(book.stop("T1")).toBe(true);
    expect(book.stop("T1")).toBe(false);
    expect(book.list()).toEqual([]);
  });

  it("refuses to watch past the per-user cap, counting every conversation", () => {
    const { store, book } = setup();
    const other = store.getOrCreateConversation(2, 0);
    for (let i = 0; i < MAX_WATCHED_THREADS; i++) {
      store.trackMailThread({ threadId: `T${i}`, conversationId: other });
    }
    const result = book.watch("one-too-many");
    expect(result).toMatchObject({ reason: "cap" });
    expect(book.list()).toEqual([]);
  });

  it("re-watching an already watched thread is allowed at the cap", () => {
    const { store, book } = setup();
    for (let i = 1; i < MAX_WATCHED_THREADS; i++) {
      store.trackMailThread({ threadId: `T${i}`, conversationId: "other" });
    }
    book.watch("mine");
    expect(book.watch("mine")).toMatchObject({ thread: { threadId: "mine" } });
  });
});
