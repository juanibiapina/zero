import { describe, expect, it, vi } from "vitest";
import { buildGoogleTools } from "./google";
import { createMailWatchBook } from "../mail-watch/book";
import { MAX_WATCHED_THREADS } from "../do/mail-watch";
import { createMemoryGoogle } from "../google/memory";
import { GoogleApiError, GoogleNotConnectedError } from "../google/types";
import { ExternalCallNotSent } from "../agents/external-call";
import { MemoryStore } from "../store/memory";
import { createMemoryFileBlobs } from "../files/memory";
import { createUserFileStore } from "../files/store";

// Invoke a tool's execute with an untyped input (mirrors research.test.ts).
const run = (
  tools: ReturnType<typeof buildGoogleTools>,
  name: keyof ReturnType<typeof buildGoogleTools>,
  input: unknown,
): Promise<unknown> => {
  return tools[name].execute(input);
};

describe("buildGoogleTools gmail", () => {
  it("gmail_search returns threads and a truncated flag", async () => {
    const google = createMemoryGoogle({
      threadSummaries: [
        { threadId: "T1", date: "d", from: "a@x.com", subject: "Hi", snippet: "s" },
      ],
    });
    const tools = buildGoogleTools({ google, timezone: "UTC" });
    const res = (await run(tools, "gmail_search", { query: "from:a" })) as {
      threads: unknown[];
      truncated: boolean;
    };
    expect(res.threads).toHaveLength(1);
    expect(res.truncated).toBe(false);
  });

  it("gmail_save_attachment stores canonical bytes and returns no base64", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7");
    const google = createMemoryGoogle({
      attachments: {
        "M1:2": { filename: "report.pdf", mimeType: "application/pdf", bytes: pdf },
      },
    });
    const files = createUserFileStore({
      clerkUserId: "user_1",
      records: new MemoryStore(),
      blobs: createMemoryFileBlobs(),
    });
    const tools = buildGoogleTools({ google, timezone: "UTC", files });
    const first = await run(tools, "gmail_save_attachment", { messageId: "M1", partId: "2" });
    const second = await run(tools, "gmail_save_attachment", { messageId: "M1", partId: "2" });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ file: {
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 8,
    } });
    const serialized = JSON.stringify(first);
    expect(serialized).toContain("[file id=file_");
    expect(serialized).not.toContain(btoa("%PDF-1.7"));
    expect(files.list({}).files).toHaveLength(1);
  });

  it("gmail_send reaches the adapter with reply linkage", async () => {
    const google = createMemoryGoogle();
    const tools = buildGoogleTools({ google, timezone: "UTC" });
    await run(tools, "gmail_send", {
      to: "bob@x.com",
      subject: "Re: Hi",
      body: "reply",
      replyTo: { messageIdHeader: "<abc@mail>", threadId: "T1" },
    });
    expect(google.sentMail).toEqual([
      {
        to: "bob@x.com",
        subject: "Re: Hi",
        body: "reply",
        replyTo: { messageIdHeader: "<abc@mail>", threadId: "T1" },
      },
    ]);
  });

  it("gmail_send watches the thread it landed in, so the reply is noticed", async () => {
    const google = createMemoryGoogle();
    const store = new MemoryStore(() => "2026-02-10T12:00:00.000Z");
    const conversationId = store.getOrCreateConversation(1, 0);
    const onWatchChanged = vi.fn();
    const tools = buildGoogleTools({
      google,
      timezone: "UTC",
      mailWatch: createMailWatchBook({ store, conversationId }),
      onWatchChanged,
    });

    await run(tools, "gmail_send", {
      to: "bob@x.com",
      subject: "Re: Hi",
      body: "reply",
      replyTo: { messageIdHeader: "<abc@mail>", threadId: "T1" },
    });

    expect(store.listMailThreads().map((t) => t.threadId)).toEqual(["T1"]);
    expect(onWatchChanged).toHaveBeenCalledOnce();
  });

  it("gmail_send_draft watches the thread too", async () => {
    const google = createMemoryGoogle();
    const store = new MemoryStore(() => "2026-02-10T12:00:00.000Z");
    const conversationId = store.getOrCreateConversation(1, 0);
    const tools = buildGoogleTools({
      google,
      timezone: "UTC",
      mailWatch: createMailWatchBook({ store, conversationId }),
    });

    const saved = (await run(tools, "gmail_draft", {
      to: "bob@x.com",
      subject: "Re: Hi",
      body: "b",
      replyTo: { messageIdHeader: "<abc@mail>", threadId: "T7" },
    })) as { draftId: string };
    await run(tools, "gmail_send_draft", { draftId: saved.draftId });

    expect(store.listMailThreads().map((t) => t.threadId)).toEqual(["T7"]);
  });

  it("a send still succeeds when the watch cap is full", async () => {
    const google = createMemoryGoogle();
    const store = new MemoryStore(() => "2026-02-10T12:00:00.000Z");
    const conversationId = store.getOrCreateConversation(1, 0);
    for (let i = 0; i < MAX_WATCHED_THREADS; i++) {
      store.trackMailThread({ threadId: `full-${i}`, conversationId });
    }
    const tools = buildGoogleTools({
      google,
      timezone: "UTC",
      mailWatch: createMailWatchBook({ store, conversationId }),
    });

    const sent = (await run(tools, "gmail_send", {
      to: "bob@x.com",
      subject: "Hi",
      body: "b",
    })) as { id: string };
    expect(sent.id).toBe("sent-1");
    expect(store.listMailThreads()).toHaveLength(MAX_WATCHED_THREADS);
  });

  it("surfaces GoogleNotConnectedError as { error } data, not a throw", async () => {
    const google = createMemoryGoogle({ notConnected: true });
    const tools = buildGoogleTools({ google, timezone: "UTC" });
    const res = (await run(tools, "gmail_search", { query: "x" })) as {
      error: string;
    };
    expect(res.error).toContain("connect");
  });
});

describe("buildGoogleTools gmail labels, threads and drafts", () => {
  const mailbox = () =>
    createMemoryGoogle({
      labels: ["Receipts"],
      threadLabels: { T1: ["INBOX", "UNREAD"] },
    });

  it("archives a thread and marks it read in one call", async () => {
    const google = mailbox();
    const tools = buildGoogleTools({ google, timezone: "UTC" });

    const res = (await run(tools, "gmail_modify_thread", {
      threadId: "T1",
      remove: ["INBOX", "UNREAD"],
    })) as { labels: string[] };

    expect(res.labels).toEqual([]);
    expect(google.modifications).toEqual([
      { threadId: "T1", add: [], remove: ["INBOX", "UNREAD"] },
    ]);
  });

  it("files a thread under an existing label, matched case-insensitively", async () => {
    const google = mailbox();
    const tools = buildGoogleTools({ google, timezone: "UTC" });

    const res = (await run(tools, "gmail_modify_thread", {
      threadId: "T1",
      add: ["receipts"],
    })) as { labels: string[] };

    expect(res.labels).toContain("Receipts");
  });

  it("names the labels that exist when the model invents one", async () => {
    const tools = buildGoogleTools({ google: mailbox(), timezone: "UTC" });

    const res = (await run(tools, "gmail_modify_thread", {
      threadId: "T1",
      add: ["Reciepts"],
    })) as { error: string };

    expect(res.error).toContain('No Gmail label named "Reciepts"');
    expect(res.error).toContain("Receipts");
  });

  it("creating a label then filing under it works in one conversation", async () => {
    const google = mailbox();
    const tools = buildGoogleTools({ google, timezone: "UTC" });

    await run(tools, "gmail_label", { name: "Trips" });
    const res = (await run(tools, "gmail_modify_thread", {
      threadId: "T1",
      add: ["Trips"],
    })) as { labels: string[] };

    expect(res.labels).toContain("Trips");
  });

  it("refuses to touch the SENT label", async () => {
    const google = mailbox();
    const tools = buildGoogleTools({ google, timezone: "UTC" });

    const res = (await run(tools, "gmail_modify_thread", {
      threadId: "T1",
      remove: ["SENT"],
    })) as { error: string };

    expect(res.error).toContain("SENT");
    expect(google.modifications).toEqual([]);
  });

  it("trashes and restores a thread", async () => {
    const google = mailbox();
    const tools = buildGoogleTools({ google, timezone: "UTC" });

    await run(tools, "gmail_trash_thread", { threadId: "T1" });
    await run(tools, "gmail_trash_thread", { threadId: "T1", restore: true });

    expect(google.trashed).toEqual([
      { threadId: "T1", restore: false },
      { threadId: "T1", restore: true },
    ]);
  });

  it("saves a draft, replaces it, and lists what is waiting", async () => {
    const google = mailbox();
    const tools = buildGoogleTools({ google, timezone: "UTC" });

    const saved = (await run(tools, "gmail_draft", {
      to: "bob@x.com",
      subject: "Re: Hello",
      body: "first version",
      replyTo: { messageIdHeader: "<abc@mail>", threadId: "T1" },
    })) as { draftId: string; threadId: string | null };
    expect(saved.threadId).toBe("T1");

    await run(tools, "gmail_draft", {
      draftId: saved.draftId,
      to: "bob@x.com",
      subject: "Re: Hello",
      body: "second version",
    });

    const listed = (await run(tools, "gmail_drafts", {})) as {
      drafts: { draftId: string; subject: string }[];
      truncated: boolean;
    };
    expect(listed.drafts).toEqual([
      { draftId: saved.draftId, to: "bob@x.com", subject: "Re: Hello", snippet: "second version" },
    ]);
    expect(listed.truncated).toBe(false);
    expect(google.savedDrafts).toHaveLength(2);
  });

  it("sends a draft once, and the draft is gone afterwards", async () => {
    const google = mailbox();
    const tools = buildGoogleTools({ google, timezone: "UTC" });
    const saved = (await run(tools, "gmail_draft", {
      to: "bob@x.com",
      subject: "Hi",
      body: "b",
    })) as { draftId: string };

    const sent = (await run(tools, "gmail_send_draft", {
      draftId: saved.draftId,
    })) as { id: string };
    expect(sent.id).toBe("sent-draft-1");

    // A second send of the same draft must not quietly succeed.
    await expect(
      run(tools, "gmail_send_draft", { draftId: saved.draftId }),
    ).rejects.toThrow("No draft with id");
  });

  it("surfaces a missing Google connection as { error } on every reversible tool", async () => {
    const google = createMemoryGoogle({ notConnected: true });
    const tools = buildGoogleTools({ google, timezone: "UTC" });

    const calls: [keyof ReturnType<typeof buildGoogleTools>, unknown][] = [
      ["gmail_labels", {}],
      ["gmail_label", { name: "Trips" }],
      ["gmail_modify_thread", { threadId: "T1", add: ["Receipts"] }],
      ["gmail_trash_thread", { threadId: "T1" }],
      ["gmail_drafts", {}],
      ["gmail_draft", { to: "b@x.com", subject: "s", body: "b" }],
    ];
    for (const [name, input] of calls) {
      const res = (await run(tools, name, input)) as { error: string };
      expect(res.error).toContain("Google isn't connected");
    }
  });
});

describe("irreversible tools classify their failures", () => {
  // A failing adapter for the two write tools. The tools must not swallow these
  // into { error } data: that is what lets the model retry a send under a new
  // tool_use id and deliver the same mail twice (see agents/run.ts).
  const failingGoogle = (err: Error) => {
    const google = createMemoryGoogle();
    return {
      ...google,
      mail: {
        ...google.mail,
        send: async () => {
          throw err;
        },
        sendDraft: async () => {
          throw err;
        },
      },
      calendar: {
        ...google.calendar,
        createEvent: async () => {
          throw err;
        },
      },
    };
  };

  const sendInput = { to: "bob@x.com", subject: "Hi", body: "b" };

  it("reports a rejected request as provably not sent", async () => {
    const tools = buildGoogleTools({
      google: failingGoogle(new GoogleApiError(400, "bad recipient")),
      timezone: "UTC",
    });
    await expect(run(tools, "gmail_send", sendInput)).rejects.toBeInstanceOf(
      ExternalCallNotSent,
    );
  });

  it("reports a missing connection as provably not sent", async () => {
    const tools = buildGoogleTools({
      google: failingGoogle(new GoogleNotConnectedError()),
      timezone: "UTC",
    });
    await expect(run(tools, "gmail_send", sendInput)).rejects.toBeInstanceOf(
      ExternalCallNotSent,
    );
  });

  it("lets an ambiguous failure through unclassified", async () => {
    // A 500, a 429 and a dead socket all leave the outcome unknown: the send may
    // have been accepted before the response was lost.
    for (const err of [
      new GoogleApiError(500, "backend error"),
      new GoogleApiError(429, "rate limited"),
      new Error("network error"),
    ]) {
      const tools = buildGoogleTools({
        google: failingGoogle(err),
        timezone: "UTC",
      });
      await expect(run(tools, "gmail_send", sendInput)).rejects.not.toBeInstanceOf(
        ExternalCallNotSent,
      );
    }
  });

  it("classifies gmail_send_draft the same way: sending is sending", async () => {
    const rejected = buildGoogleTools({
      google: failingGoogle(new GoogleApiError(404, "no such draft")),
      timezone: "UTC",
    });
    await expect(
      run(rejected, "gmail_send_draft", { draftId: "D1" }),
    ).rejects.toBeInstanceOf(ExternalCallNotSent);

    const ambiguous = buildGoogleTools({
      google: failingGoogle(new GoogleApiError(500, "backend error")),
      timezone: "UTC",
    });
    await expect(
      run(ambiguous, "gmail_send_draft", { draftId: "D1" }),
    ).rejects.not.toBeInstanceOf(ExternalCallNotSent);
  });

  it("classifies calendar_create_event the same way", async () => {
    const event = { summary: "s", start: "2026-01-01T09:00", end: "2026-01-01T10:00" };
    const rejected = buildGoogleTools({
      google: failingGoogle(new GoogleApiError(403, "no access")),
      timezone: "UTC",
    });
    await expect(
      run(rejected, "calendar_create_event", event),
    ).rejects.toBeInstanceOf(ExternalCallNotSent);

    const ambiguous = buildGoogleTools({
      google: failingGoogle(new Error("socket hang up")),
      timezone: "UTC",
    });
    await expect(
      run(ambiguous, "calendar_create_event", event),
    ).rejects.not.toBeInstanceOf(ExternalCallNotSent);
  });
});

describe("buildGoogleTools calendar", () => {
  it("calendar_list_events resolves wall-clock to the user zone and aggregates", async () => {
    const google = createMemoryGoogle({
      events: [
        {
          summary: "E",
          start: { dateTime: "2026-07-17T09:00:00+02:00", timeZone: "Europe/Berlin" },
          end: { dateTime: "2026-07-17T10:00:00+02:00", timeZone: "Europe/Berlin" },
          calendarId: "primary",
        },
      ],
    });
    const tools = buildGoogleTools({ google, timezone: "Europe/Berlin" });
    const res = (await run(tools, "calendar_list_events", {
      from: "2026-07-17",
      to: "2026-07-17",
    })) as { events: unknown[]; truncated: boolean };
    expect(res.events).toHaveLength(1);
    expect(res.truncated).toBe(false);
  });

  it("calendar_create_event stamps the user zone on wall-clock times", async () => {
    const google = createMemoryGoogle();
    const tools = buildGoogleTools({ google, timezone: "Europe/Berlin" });
    await run(tools, "calendar_create_event", {
      summary: "Sync",
      start: "2026-07-17T09:00",
      end: "2026-07-17T10:00",
    });
    expect(google.createdEvents[0]).toEqual({
      calendarId: "primary",
      event: {
        summary: "Sync",
        description: undefined,
        location: undefined,
        attendees: undefined,
        start: { dateTime: "2026-07-17T09:00:00", timeZone: "Europe/Berlin" },
        end: { dateTime: "2026-07-17T10:00:00", timeZone: "Europe/Berlin" },
      },
    });
  });

  it("calendar_create_event honors allDay and a non-default calendarId", async () => {
    const google = createMemoryGoogle();
    const tools = buildGoogleTools({ google, timezone: "Europe/Berlin" });
    await run(tools, "calendar_create_event", {
      summary: "Holiday",
      start: "2026-12-25",
      end: "2026-12-26",
      allDay: true,
      calendarId: "work@grp",
    });
    expect(google.createdEvents[0]).toEqual({
      calendarId: "work@grp",
      event: {
        summary: "Holiday",
        description: undefined,
        location: undefined,
        attendees: undefined,
        start: { date: "2026-12-25" },
        end: { date: "2026-12-26" },
      },
    });
  });
});

describe("buildGoogleTools drive", () => {
  const pdfBytes = new TextEncoder().encode("%PDF-1.7 drive");

  const driveGoogle = () =>
    createMemoryGoogle({
      driveFiles: [
        {
          id: "F1",
          name: "report.pdf",
          mimeType: "application/pdf",
          byteSize: pdfBytes.length,
          modifiedAt: "2026-08-01T10:00:00.000Z",
          webViewLink: "https://drive.google.com/file/d/F1",
          isFolder: false,
        },
        {
          id: "S1",
          name: "Budget",
          mimeType: "application/vnd.google-apps.spreadsheet",
          byteSize: null,
          modifiedAt: "2026-08-02T10:00:00.000Z",
          webViewLink: null,
          isFolder: false,
        },
      ],
      driveBytes: { F1: pdfBytes },
    });

  const newFileStore = () =>
    createUserFileStore({
      clerkUserId: "user_1",
      records: new MemoryStore(),
      blobs: createMemoryFileBlobs(),
    });

  it("drive_search returns files with a truncated flag", async () => {
    const tools = buildGoogleTools({ google: driveGoogle(), timezone: "UTC" });
    const res = (await run(tools, "drive_search", { query: "report" })) as {
      files: { id: string }[];
      truncated: boolean;
    };
    expect(res.files.map((f) => f.id)).toEqual(["F1", "S1"]);
    expect(res.truncated).toBe(false);
  });

  it("drive_import stores the file, returns a marker, and does not store it twice", async () => {
    const files = newFileStore();
    const tools = buildGoogleTools({ google: driveGoogle(), timezone: "UTC", files });

    const first = await run(tools, "drive_import", { fileId: "F1" });
    const second = await run(tools, "drive_import", { fileId: "F1" });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      file: { filename: "report.pdf", mimeType: "application/pdf", byteSize: pdfBytes.length },
    });
    const serialized = JSON.stringify(first);
    expect(serialized).toContain("[file id=file_");
    expect(serialized).not.toContain("JVBER");
    expect(files.list({}).files).toHaveLength(1);
  });

  it("drive_import reports missing file storage as data, since onboarding has none", async () => {
    const tools = buildGoogleTools({ google: driveGoogle(), timezone: "UTC" });
    expect(await run(tools, "drive_import", { fileId: "F1" })).toEqual({
      error: "File storage is unavailable.",
    });
  });

  it("drive_import surfaces a bad export as data rather than crashing", async () => {
    // The store refuses bytes that claim to be a PDF but are not.
    const google = createMemoryGoogle({
      driveFiles: [
        {
          id: "D1",
          name: "Report.pdf",
          mimeType: "application/pdf",
          byteSize: 4,
          modifiedAt: "2026-08-01T10:00:00.000Z",
          webViewLink: null,
          isFolder: false,
        },
      ],
      driveBytes: { D1: new TextEncoder().encode("nope") },
    });
    const tools = buildGoogleTools({ google, timezone: "UTC", files: newFileStore() });
    expect(await run(tools, "drive_import", { fileId: "D1" })).toMatchObject({
      error: expect.stringContaining("not a valid PDF") as unknown,
    });
  });

  it("drive_create_folder and drive_trash record reversible changes", async () => {
    const google = driveGoogle();
    const tools = buildGoogleTools({ google, timezone: "UTC" });

    const folder = (await run(tools, "drive_create_folder", { name: "Receipts" })) as {
      id: string;
      isFolder: boolean;
    };
    expect(folder.isFolder).toBe(true);
    expect(google.createdFolders).toEqual([{ name: "Receipts", parentId: undefined }]);

    expect(await run(tools, "drive_trash", { fileId: "F1" })).toMatchObject({ trashed: true });
    expect(await run(tools, "drive_trash", { fileId: "F1", restore: true })).toMatchObject({
      trashed: false,
    });
    expect(google.trashedFiles).toEqual([
      { fileId: "F1", restore: false },
      { fileId: "F1", restore: true },
    ]);
  });

  it("drive_upload sends a stored Zero file to Drive", async () => {
    const google = driveGoogle();
    const files = newFileStore();
    const stored = await files.save({
      filename: "notes.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("hello"),
    });
    const tools = buildGoogleTools({ google, timezone: "UTC", files });

    await run(tools, "drive_upload", { fileId: stored.id, folderId: "FOLDER1" });

    expect(google.uploadedFiles).toHaveLength(1);
    expect(google.uploadedFiles[0]).toMatchObject({
      filename: "notes.txt",
      mimeType: "text/plain",
      folderId: "FOLDER1",
    });
  });

  it("drive_upload reports an unknown file as provably not sent", async () => {
    const tools = buildGoogleTools({
      google: driveGoogle(),
      timezone: "UTC",
      files: newFileStore(),
    });
    await expect(
      run(tools, "drive_upload", { fileId: "file_missing" }),
    ).rejects.toBeInstanceOf(ExternalCallNotSent);
  });

  it("drive_upload classifies its failures like every other irreversible tool", async () => {
    const files = newFileStore();
    const stored = await files.save({
      filename: "notes.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("hello"),
    });
    const failing = (err: Error) => {
      const google = driveGoogle();
      return {
        ...google,
        drive: {
          ...google.drive,
          upload: async () => {
            throw err;
          },
        },
      };
    };

    const rejected = buildGoogleTools({
      google: failing(new GoogleApiError(403, "read-only shared drive")),
      timezone: "UTC",
      files,
    });
    await expect(
      run(rejected, "drive_upload", { fileId: stored.id }),
    ).rejects.toBeInstanceOf(ExternalCallNotSent);

    const ambiguous = buildGoogleTools({
      google: failing(new GoogleApiError(500, "backend error")),
      timezone: "UTC",
      files,
    });
    await expect(
      run(ambiguous, "drive_upload", { fileId: stored.id }),
    ).rejects.not.toBeInstanceOf(ExternalCallNotSent);
  });

  it("surfaces GoogleNotConnectedError as { error } for reads and as not-sent for upload", async () => {
    const google = createMemoryGoogle({ notConnected: true });
    const files = newFileStore();
    const stored = await files.save({
      filename: "notes.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("hello"),
    });
    const tools = buildGoogleTools({ google, timezone: "UTC", files });

    expect(await run(tools, "drive_search", { query: "x" })).toMatchObject({
      error: expect.stringContaining("Google isn't connected") as unknown,
    });
    await expect(
      run(tools, "drive_upload", { fileId: stored.id }),
    ).rejects.toBeInstanceOf(ExternalCallNotSent);
  });
});
