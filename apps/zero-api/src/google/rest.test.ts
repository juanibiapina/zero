import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleWorkspace } from "./rest";
import { GoogleNotConnectedError } from "./types";
import { MAX_FILE_BYTES } from "../files/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const b64url = (s: string) =>
  btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const decodeB64url = (s: string) => {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(norm)));
};

const urlOf = (input: RequestInfo | URL): string =>
  input instanceof URL
    ? input.href
    : typeof input === "string"
      ? input
      : input.url;

// Route fetch mock by URL substring.
const routed = (routes: { match: string; response: () => Response }[]) =>
  vi.fn<typeof fetch>(async (input) => {
    const url = urlOf(input);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no route for ${url}`);
    return route.response();
  });

const token = async () => "tok-123";

describe("createGoogleWorkspace mail", () => {
  it("getThread decodes multipart bodies, prefers text/plain, surfaces Message-ID + threadId", async () => {
    const fetchMock = routed([
      {
        match: "/threads/T1?format=full",
        response: () =>
          json({
            messages: [
              {
                id: "M1",
                threadId: "T1",
                payload: {
                  mimeType: "multipart/mixed",
                  headers: [
                    { name: "From", value: "alice@example.com" },
                    { name: "To", value: "me@example.com" },
                    { name: "Subject", value: "Hello" },
                    { name: "Date", value: "Mon, 1 Jun 2026 10:00:00 +0000" },
                    { name: "Message-ID", value: "<abc@mail>" },
                  ],
                  parts: [
                    {
                      mimeType: "multipart/alternative",
                      parts: [
                        { mimeType: "text/plain", body: { data: b64url("plain body") } },
                        { mimeType: "text/html", body: { data: b64url("<p>html body</p>") } },
                      ],
                    },
                  ],
                },
              },
            ],
          }),
      },
    ]);
    globalThis.fetch = fetchMock;

    const g = createGoogleWorkspace(token);
    const thread = await g.mail.getThread("T1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(urlOf(url)).toContain("users/me/threads/T1?format=full");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-123",
    );
    expect(thread.messages[0]).toMatchObject({
      id: "M1",
      threadId: "T1",
      messageIdHeader: "<abc@mail>",
      from: "alice@example.com",
      subject: "Hello",
      body: "plain body",
    });
  });

  it("getThread finds a lower-cased Message-Id header", async () => {
    globalThis.fetch = routed([
      {
        match: "/threads/T2",
        response: () =>
          json({
            messages: [
              {
                id: "M2",
                threadId: "T2",
                payload: {
                  headers: [{ name: "Message-Id", value: "<low@mail>" }],
                  body: { data: b64url("body") },
                },
              },
            ],
          }),
      },
    ]);

    const g = createGoogleWorkspace(token);
    const thread = await g.mail.getThread("T2");
    expect(thread.messages[0].messageIdHeader).toBe("<low@mail>");
    expect(thread.messages[0].body).toBe("body");
  });

  it("discovers named attachments recursively with distinct part ids", async () => {
    globalThis.fetch = routed([{
      match: "/threads/T3?format=full",
      response: () => json({ messages: [{
        id: "M3",
        threadId: "T3",
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "multipart/related", parts: [
              { partId: "1.1", filename: "résumé.pdf", mimeType: "application/pdf", body: { size: 7, attachmentId: "A1" } },
            ] },
            { partId: "2", filename: "résumé.pdf", mimeType: "application/pdf", body: { size: 8, attachmentId: "A2" } },
          ],
        },
      }] }),
    }]);
    const thread = await createGoogleWorkspace(token).mail.getThread("T3");
    expect(thread.messages[0].attachments).toEqual([
      { partId: "1.1", filename: "résumé.pdf", mimeType: "application/pdf", byteSize: 7 },
      { partId: "2", filename: "résumé.pdf", mimeType: "application/pdf", byteSize: 8 },
    ]);
  });

  it("re-fetches canonical part metadata and downloads inline bytes", async () => {
    globalThis.fetch = routed([{
      match: "/messages/M4?format=full",
      response: () => json({ id: "M4", threadId: "T4", payload: {
        parts: [{ partId: "2", filename: "report.pdf", mimeType: "application/pdf", body: { size: 8, data: b64url("%PDF-1.7") } }],
      } }),
    }]);
    const attachment = await createGoogleWorkspace(token).mail.downloadAttachment("M4", "2");
    expect(attachment).toMatchObject({ filename: "report.pdf", mimeType: "application/pdf", declaredSize: 8 });
    expect(new TextDecoder().decode(attachment.bytes)).toBe("%PDF-1.7");
  });

  it("downloads endpoint-backed bytes and rejects missing or changed parts", async () => {
    globalThis.fetch = routed([
      { match: "/messages/M5?format=full", response: () => json({ id: "M5", payload: { parts: [
        { partId: "3", filename: "a.txt", mimeType: "text/plain", body: { size: 3, attachmentId: "A3" } },
      ] } }) },
      { match: "/messages/M5/attachments/A3", response: () => json({ size: 3, data: b64url("abc") }) },
    ]);
    const mail = createGoogleWorkspace(token).mail;
    expect(new TextDecoder().decode((await mail.downloadAttachment("M5", "3")).bytes)).toBe("abc");
    await expect(mail.downloadAttachment("M5", "missing")).rejects.toThrow("missing or changed");
  });

  it("rejects a declared oversize part before downloading attachment bytes", async () => {
    const fetchMock = routed([{
      match: "/messages/M7?format=full",
      response: () => json({ id: "M7", payload: { parts: [
        { partId: "1", filename: "big.bin", body: { size: MAX_FILE_BYTES + 1, attachmentId: "A7" } },
      ] } }),
    }]);
    globalThis.fetch = fetchMock;
    await expect(createGoogleWorkspace(token).mail.downloadAttachment("M7", "1")).rejects.toThrow("too large");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed data and post-download size changes", async () => {
    const payload = (data: string, size: number) => json({ id: "M6", payload: { parts: [
      { partId: "1", filename: "a.bin", mimeType: "application/octet-stream", body: { size, data } },
    ] } });
    globalThis.fetch = routed([{ match: "/messages/M6", response: () => payload("***", 2) }]);
    const mail = createGoogleWorkspace(token).mail;
    await expect(mail.downloadAttachment("M6", "1")).rejects.toThrow("Malformed");
    globalThis.fetch = routed([{ match: "/messages/M6", response: () => payload(b64url("abc"), 2) }]);
    await expect(mail.downloadAttachment("M6", "1")).rejects.toThrow("size changed");
  });

  it("send builds a base64url MIME message, round-trips non-ASCII subject/body", async () => {
    globalThis.fetch = routed([
      {
        match: "/messages/send",
        response: () => json({ id: "sent-1" }),
      },
    ]);
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    const g = createGoogleWorkspace(token);
    await g.mail.send({
      to: "bob@example.com",
      subject: "Café ☕",
      body: "Héllo wörld",
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const sentBody = JSON.parse(init.body as string) as {
      raw: string;
      threadId?: string;
    };
    expect(sentBody.threadId).toBeUndefined();
    const mime = decodeB64url(sentBody.raw);
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain("=?UTF-8?B?"); // encoded-word subject
    // Body is base64 of the UTF-8 content.
    const bodyLine = mime.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(decodeURIComponent(escape(atob(bodyLine)))).toBe("Héllo wörld");
  });

  it("send sets In-Reply-To/References + threadId for a reply", async () => {
    globalThis.fetch = routed([
      { match: "/messages/send", response: () => json({ id: "sent-2" }) },
    ]);
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    const g = createGoogleWorkspace(token);
    await g.mail.send({
      to: "bob@example.com",
      subject: "Re: Hello",
      body: "a reply",
      replyTo: { messageIdHeader: "<abc@mail>", threadId: "T1" },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const parsed = JSON.parse(init.body as string) as {
      raw: string;
      threadId?: string;
    };
    expect(parsed.threadId).toBe("T1");
    const mime = decodeB64url(parsed.raw);
    expect(mime).toContain("In-Reply-To: <abc@mail>");
    expect(mime).toContain("References: <abc@mail>");
    expect(mime).toContain("Subject: Re: Hello");
  });

  it("search fetches thread metadata and maps summaries", async () => {
    globalThis.fetch = routed([
      {
        match: "/threads?q=",
        response: () => json({ threads: [{ id: "T1", snippet: "snip" }] }),
      },
      {
        match: "/threads/T1?format=metadata",
        response: () =>
          json({
            messages: [
              {
                id: "M1",
                threadId: "T1",
                payload: {
                  headers: [
                    { name: "From", value: "alice@example.com" },
                    { name: "Subject", value: "Hi" },
                    { name: "Date", value: "today" },
                  ],
                },
              },
            ],
          }),
      },
    ]);

    const g = createGoogleWorkspace(token);
    const results = await g.mail.search("from:alice");
    expect(results).toEqual([
      {
        threadId: "T1",
        date: "today",
        from: "alice@example.com",
        subject: "Hi",
        snippet: "snip",
      },
    ]);
  });
});

describe("createGoogleWorkspace labels and thread state", () => {
  const labels = () =>
    json({
      labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "UNREAD", name: "UNREAD", type: "system" },
        { id: "STARRED", name: "STARRED", type: "system" },
        { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
        { id: "CHAT", name: "CHAT", type: "system" },
        { id: "Label_12", name: "Receipts", type: "user" },
        { id: "Label_13", name: "Work/Invoices", type: "user" },
      ],
    });

  it("lists the user's labels and the system labels worth naming", async () => {
    globalThis.fetch = routed([{ match: "/labels", response: labels }]);

    const listed = await createGoogleWorkspace(token).mail.listLabels();

    expect(listed).toEqual([
      { name: "INBOX", type: "system" },
      { name: "UNREAD", type: "system" },
      { name: "STARRED", type: "system" },
      { name: "Receipts", type: "user" },
      { name: "Work/Invoices", type: "user" },
    ]);
  });

  it("archives a thread by name, reporting the labels it now carries", async () => {
    const fetchMock = routed([
      { match: "/labels", response: labels },
      {
        match: "/threads/T1/modify",
        response: () => json({ messages: [{ labelIds: ["Label_12"] }] }),
      },
    ]);
    globalThis.fetch = fetchMock;

    const result = await createGoogleWorkspace(token).mail.modifyThread({
      threadId: "T1",
      add: ["receipts"], // case-insensitive on purpose
      remove: ["INBOX"],
    });

    const modify = fetchMock.mock.calls.find(([url]) =>
      urlOf(url).includes("/modify"),
    );
    expect((modify?.[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((modify?.[1] as RequestInit).body as string)).toEqual({
      addLabelIds: ["Label_12"],
      removeLabelIds: ["INBOX"],
    });
    expect(result).toEqual({ threadId: "T1", labels: ["Receipts"] });
  });

  it("names the labels that do exist when asked for one that does not", async () => {
    globalThis.fetch = routed([{ match: "/labels", response: labels }]);

    await expect(
      createGoogleWorkspace(token).mail.modifyThread({
        threadId: "T1",
        add: ["Reciepts"],
      }),
    ).rejects.toThrow('No Gmail label named "Reciepts". Existing labels: Receipts, Work/Invoices.');
  });

  it("refuses SENT and DRAFT without calling Gmail", async () => {
    const fetchMock = routed([{ match: "/labels", response: labels }]);
    globalThis.fetch = fetchMock;

    await expect(
      createGoogleWorkspace(token).mail.modifyThread({
        threadId: "T1",
        remove: ["SENT"],
      }),
    ).rejects.toThrow("does not allow adding or removing the SENT label");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the label list once for two modifies", async () => {
    const fetchMock = routed([
      { match: "/labels", response: labels },
      { match: "/modify", response: () => json({ messages: [] }) },
    ]);
    globalThis.fetch = fetchMock;

    const mail = createGoogleWorkspace(token).mail;
    await mail.modifyThread({ threadId: "T1", add: ["Receipts"] });
    await mail.modifyThread({ threadId: "T2", add: ["Receipts"] });

    const labelCalls = fetchMock.mock.calls.filter(
      ([url]) => urlOf(url).endsWith("/labels"),
    );
    expect(labelCalls).toHaveLength(1);
  });

  it("creating a label re-reads the list, so it can be used immediately", async () => {
    let created = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = urlOf(input);
      if (url.endsWith("/labels") && init?.method === "POST") {
        created = true;
        return json({ id: "Label_20", name: "Trips", type: "user" });
      }
      if (url.endsWith("/labels")) {
        return json({
          labels: created
            ? [{ id: "Label_20", name: "Trips", type: "user" }]
            : [],
        });
      }
      return json({ messages: [{ labelIds: ["Label_20"] }] });
    });
    globalThis.fetch = fetchMock;

    const mail = createGoogleWorkspace(token).mail;
    expect(await mail.createLabel("Trips")).toEqual({ name: "Trips", type: "user" });
    const result = await mail.modifyThread({ threadId: "T1", add: ["Trips"] });

    expect(result.labels).toEqual(["Trips"]);
  });

  it("renames a label by patching its id", async () => {
    const fetchMock = routed([
      { match: "/labels/Label_12", response: () => json({ id: "Label_12", name: "Bills", type: "user" }) },
      { match: "/labels", response: labels },
    ]);
    globalThis.fetch = fetchMock;

    const renamed = await createGoogleWorkspace(token).mail.renameLabel(
      "Receipts",
      "Bills",
    );

    const patch = fetchMock.mock.calls.find(([url]) =>
      urlOf(url).includes("/labels/Label_12"),
    );
    expect((patch?.[1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({
      name: "Bills",
    });
    expect(renamed).toEqual({ name: "Bills", type: "user" });
  });

  it("trashes and restores a thread", async () => {
    const fetchMock = routed([{ match: "/threads/", response: () => json({}) }]);
    globalThis.fetch = fetchMock;

    const mail = createGoogleWorkspace(token).mail;
    await mail.trashThread("T1");
    await mail.untrashThread("T1");

    expect(fetchMock.mock.calls.map(([url]) => urlOf(url))).toEqual([
      expect.stringContaining("/threads/T1/trash"),
      expect.stringContaining("/threads/T1/untrash"),
    ]);
  });
});

describe("createGoogleWorkspace drafts", () => {
  it("fills in To/Subject with one metadata read per draft", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.includes("/drafts/D1"))
        return json({
          message: {
            id: "M1",
            threadId: "T1",
            snippet: "about the invoice",
            payload: {
              headers: [
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: "Re: Invoice" },
              ],
            },
          },
        });
      return json({ drafts: [{ id: "D1" }] });
    });
    globalThis.fetch = fetchMock;

    const drafts = await createGoogleWorkspace(token).mail.listDrafts();

    expect(drafts).toEqual([
      {
        draftId: "D1",
        to: "bob@example.com",
        subject: "Re: Invoice",
        snippet: "about the invoice",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("creates a draft reply carrying the same threading headers as a send", async () => {
    const fetchMock = routed([
      { match: "/drafts", response: () => json({ id: "D9", message: { threadId: "T1" } }) },
    ]);
    globalThis.fetch = fetchMock;

    const saved = await createGoogleWorkspace(token).mail.saveDraft({
      to: "bob@example.com",
      subject: "Re: Hello",
      body: "a draft reply",
      replyTo: { messageIdHeader: "<abc@mail>", threadId: "T1" },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      message: { raw: string; threadId?: string };
    };
    expect(body.message.threadId).toBe("T1");
    const mime = decodeB64url(body.message.raw);
    expect(mime).toContain("In-Reply-To: <abc@mail>");
    expect(mime).toContain("References: <abc@mail>");
    expect(mime).toContain("Subject: Re: Hello");
    expect(saved).toEqual({ draftId: "D9", threadId: "T1" });
  });

  it("updates a draft by replacing the whole message", async () => {
    const fetchMock = routed([
      { match: "/drafts/D9", response: () => json({ id: "D9" }) },
    ]);
    globalThis.fetch = fetchMock;

    await createGoogleWorkspace(token).mail.saveDraft({
      draftId: "D9",
      to: "bob@example.com",
      subject: "Re: Hello",
      body: "second version",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(urlOf(url)).toContain("/drafts/D9");
    expect((init as RequestInit).method).toBe("PUT");
    const body = JSON.parse((init as RequestInit).body as string) as {
      message: { raw: string };
    };
    const mime = decodeB64url(body.message.raw);
    const bodyLine = mime.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(atob(bodyLine)).toBe("second version");
    expect(mime).toContain("To: bob@example.com");
  });

  it("sends a draft by id and returns the sent message", async () => {
    const fetchMock = routed([
      { match: "/drafts/send", response: () => json({ id: "M-sent" }) },
    ]);
    globalThis.fetch = fetchMock;

    const sent = await createGoogleWorkspace(token).mail.sendDraft("D9");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ id: "D9" });
    expect(sent).toEqual({ id: "M-sent" });
  });
});

describe("createGoogleWorkspace mail history", () => {
  it("send reports the thread the message landed in", async () => {
    globalThis.fetch = routed([
      { match: "/messages/send", response: () => json({ id: "M9", threadId: "T9" }) },
    ]);
    const google = createGoogleWorkspace(token);
    await expect(
      google.mail.send({ to: "a@b.c", subject: "hi", body: "there" }),
    ).resolves.toEqual({ id: "M9", threadId: "T9" });
  });

  it("getWatermark reads the mailbox history id from the profile", async () => {
    globalThis.fetch = routed([
      { match: "/profile", response: () => json({ historyId: "4242" }) },
    ]);
    const google = createGoogleWorkspace(token);
    await expect(google.mail.getWatermark()).resolves.toEqual({ historyId: "4242" });
  });

  it("listChangedThreads asks only for inbox message additions and dedupes threads", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      urls.push(urlOf(input));
      return json({
        history: [
          { messagesAdded: [{ message: { id: "M1", threadId: "T1" } }] },
          {
            messagesAdded: [
              { message: { id: "M2", threadId: "T1" } },
              { message: { id: "M3", threadId: "T2" } },
            ],
          },
        ],
        historyId: "5000",
      });
    });
    const google = createGoogleWorkspace(token);
    const result = await google.mail.listChangedThreads("4000");
    expect(result).toEqual({ ok: true, historyId: "5000", threadIds: ["T1", "T2"] });
    expect(urls[0]).toContain("startHistoryId=4000");
    expect(urls[0]).toContain("historyTypes=messageAdded");
    expect(urls[0]).toContain("labelId=INBOX");
  });

  it("listChangedThreads follows pages and merges them", async () => {
    let call = 0;
    globalThis.fetch = vi.fn<typeof fetch>(async () => {
      call++;
      return call === 1
        ? json({
            history: [{ messagesAdded: [{ message: { threadId: "T1" } }] }],
            nextPageToken: "p2",
            historyId: "5000",
          })
        : json({
            history: [{ messagesAdded: [{ message: { threadId: "T2" } }] }],
            historyId: "5001",
          });
    });
    const google = createGoogleWorkspace(token);
    await expect(google.mail.listChangedThreads("4000")).resolves.toEqual({
      ok: true,
      historyId: "5001",
      threadIds: ["T1", "T2"],
    });
    expect(call).toBe(2);
  });

  it("listChangedThreads reports an out-of-range watermark as expired, not an error", async () => {
    globalThis.fetch = routed([
      { match: "/history", response: () => json({ error: "gone" }, 404) },
    ]);
    const google = createGoogleWorkspace(token);
    await expect(google.mail.listChangedThreads("1")).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("listChangedThreads still throws on other Gmail failures", async () => {
    globalThis.fetch = routed([
      { match: "/history", response: () => json({ error: "boom" }, 500) },
    ]);
    const google = createGoogleWorkspace(token);
    await expect(google.mail.listChangedThreads("1")).rejects.toThrow(/500/);
  });
});

describe("createGoogleWorkspace calendar", () => {
  const calendarList = () =>
    json({
      items: [
        { id: "primary", summary: "Me", primary: true, accessRole: "owner" },
        { id: "work@grp", summary: "Work", accessRole: "reader" },
        { id: "busy@grp", summary: "Busy", accessRole: "freeBusyReader" },
      ],
    });

  it("listCalendars maps calendarList", async () => {
    globalThis.fetch = routed([
      { match: "/users/me/calendarList", response: calendarList },
    ]);
    const g = createGoogleWorkspace(token);
    const cals = await g.calendar.listCalendars();
    expect(cals).toEqual([
      { id: "primary", summary: "Me", primary: true, accessRole: "owner" },
      { id: "work@grp", summary: "Work", primary: false, accessRole: "reader" },
      { id: "busy@grp", summary: "Busy", primary: false, accessRole: "freeBusyReader" },
    ]);
  });

  it("listEvents fans out over accessible calendars, tags, merges sorted, skips no-access", async () => {
    const eventUrls: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.includes("/users/me/calendarList")) return calendarList();
      if (url.includes("/events")) {
        eventUrls.push(url);
        if (url.includes("primary")) {
          return json({
            items: [
              {
                id: "e-late",
                summary: "Late",
                start: { dateTime: "2026-07-17T15:00:00Z" },
                end: { dateTime: "2026-07-17T16:00:00Z" },
              },
            ],
          });
        }
        // work calendar
        return json({
          items: [
            {
              id: "e-early",
              summary: "Early",
              start: { dateTime: "2026-07-17T09:00:00Z" },
              end: { dateTime: "2026-07-17T10:00:00Z" },
            },
          ],
        });
      }
      throw new Error(`no route ${url}`);
    });

    const g = createGoogleWorkspace(token);
    const events = await g.calendar.listEvents({
      from: "2026-07-17T00:00:00+00:00",
      to: "2026-07-17T23:59:59+00:00",
    });

    // freeBusyReader calendar skipped: only primary + work queried.
    expect(eventUrls).toHaveLength(2);
    for (const u of eventUrls) {
      expect(u).toContain("singleEvents=true");
      expect(u).toContain("orderBy=startTime");
      expect(u).toContain("timeMin=2026-07-17T00%3A00%3A00%2B00%3A00");
      expect(u).toContain("timeMax=2026-07-17T23%3A59%3A59%2B00%3A00");
    }
    // Merged sorted by start: early before late; each tagged with its calendar.
    expect(events.map((e) => e.id)).toEqual(["e-early", "e-late"]);
    expect(events[0]).toMatchObject({ calendarId: "work@grp", calendarSummary: "Work" });
    expect(events[1]).toMatchObject({ calendarId: "primary", calendarSummary: "Me" });
  });

  it("createEvent posts {dateTime,timeZone} to a non-default calendar", async () => {
    let posted: unknown;
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = urlOf(input);
      expect(url).toContain("/calendars/work%40grp/events");
      posted = JSON.parse((init as RequestInit).body as string);
      return json({ id: "evt-1", summary: "Sync" });
    });

    const g = createGoogleWorkspace(token);
    const created = await g.calendar.createEvent(
      {
        summary: "Sync",
        start: { dateTime: "2026-07-17T09:00:00", timeZone: "Europe/Berlin" },
        end: { dateTime: "2026-07-17T10:00:00", timeZone: "Europe/Berlin" },
      },
      "work@grp",
    );
    expect(posted).toMatchObject({
      summary: "Sync",
      start: { dateTime: "2026-07-17T09:00:00", timeZone: "Europe/Berlin" },
    });
    expect(created.calendarId).toBe("work@grp");
  });
});

describe("createGoogleWorkspace errors", () => {
  it("throws GoogleNotConnectedError when the token provider returns null", async () => {
    globalThis.fetch = vi.fn<typeof fetch>();
    const g = createGoogleWorkspace(async () => null);
    await expect(g.mail.search("x")).rejects.toBeInstanceOf(
      GoogleNotConnectedError,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("maps 401 to a scope/token error", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      new Response("no", { status: 401 }),
    );
    const g = createGoogleWorkspace(token);
    await expect(g.calendar.listCalendars()).rejects.toThrow(/401/);
  });

  it("maps other non-2xx to an error", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      new Response("boom", { status: 500 }),
    );
    const g = createGoogleWorkspace(token);
    await expect(g.calendar.listCalendars()).rejects.toThrow(/500/);
  });
});

describe("createGoogleWorkspace drive", () => {
  it("search excludes trash, escapes quotes, bounds the page, and asks for shared drives", async () => {
    let requested = "";
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      requested = urlOf(input);
      return json({
        files: [
          {
            id: "F1",
            name: "quinn's paper",
            mimeType: "application/pdf",
            size: "1234",
            modifiedTime: "2026-08-01T10:00:00.000Z",
            webViewLink: "https://drive.google.com/file/d/F1",
          },
        ],
      });
    });

    const g = createGoogleWorkspace(token);
    const files = await g.drive.search({ query: "quinn's \\ paper" });

    const q = decodeURIComponent(new URL(requested).searchParams.get("q") ?? "");
    expect(q).toContain("trashed = false");
    // Both the backslash and the apostrophe are escaped, or the query is malformed.
    expect(q).toContain("name contains 'quinn\\'s \\\\ paper'");
    expect(q).toContain("fullText contains");
    const params = new URL(requested).searchParams;
    expect(params.get("pageSize")).toBe("20");
    expect(params.get("supportsAllDrives")).toBe("true");
    expect(params.get("includeItemsFromAllDrives")).toBe("true");
    expect(params.get("fields")).toContain("size");
    expect(files[0]).toEqual({
      id: "F1",
      name: "quinn's paper",
      mimeType: "application/pdf",
      byteSize: 1234,
      modifiedAt: "2026-08-01T10:00:00.000Z",
      webViewLink: "https://drive.google.com/file/d/F1",
      isFolder: false,
    });
  });

  it("search filters by mime type and folder", async () => {
    let requested = "";
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      requested = urlOf(input);
      return json({ files: [] });
    });

    const g = createGoogleWorkspace(token);
    await g.drive.search({ mimeType: "application/pdf", folderId: "FOLDER1" });

    const q = decodeURIComponent(new URL(requested).searchParams.get("q") ?? "");
    expect(q).toContain("mimeType = 'application/pdf'");
    expect(q).toContain("'FOLDER1' in parents");
  });

  it("download follows a shortcut to its target before fetching bytes", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      urls.push(url);
      if (url.includes("/files/SHORT?")) {
        return json({
          id: "SHORT",
          name: "link to report",
          mimeType: "application/vnd.google-apps.shortcut",
          shortcutDetails: { targetId: "REAL", targetMimeType: "application/pdf" },
        });
      }
      if (url.includes("/files/REAL?") && !url.includes("alt=media")) {
        return json({ id: "REAL", name: "report.pdf", mimeType: "application/pdf", size: "8" });
      }
      return new Response(new TextEncoder().encode("%PDF-1.7"), { status: 200 });
    });

    const g = createGoogleWorkspace(token);
    const download = await g.drive.download("SHORT");

    expect(download).toMatchObject({ filename: "report.pdf", mimeType: "application/pdf" });
    expect(new TextDecoder().decode(download.bytes)).toBe("%PDF-1.7");
    expect(urls.some((u) => u.includes("/files/REAL?alt=media"))).toBe(true);
  });

  it("download exports a Google Doc as PDF and names it with the extension", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      urls.push(url);
      if (url.includes("/export")) {
        return new Response(new TextEncoder().encode("%PDF-1.7 doc"), { status: 200 });
      }
      return json({ id: "D1", name: "Report", mimeType: "application/vnd.google-apps.document" });
    });

    const g = createGoogleWorkspace(token);
    const download = await g.drive.download("D1");

    expect(urls.some((u) => u.includes("/export?mimeType=application%2Fpdf"))).toBe(true);
    expect(download).toMatchObject({ filename: "Report.pdf", mimeType: "application/pdf" });
    // A native file has no bytes to fetch with alt=media.
    expect(urls.some((u) => u.includes("alt=media"))).toBe(false);
  });

  it("download exports a Sheet as CSV", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.includes("/export")) {
        expect(url).toContain("mimeType=text%2Fcsv");
        return new Response(new TextEncoder().encode("a,b\n1,2"), { status: 200 });
      }
      return json({ id: "S1", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" });
    });

    const g = createGoogleWorkspace(token);
    expect(await g.drive.download("S1")).toMatchObject({
      filename: "Budget.csv",
      mimeType: "text/csv",
    });
  });

  it("refuses an oversize file from its declared size, before fetching bytes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json({
        id: "BIG",
        name: "huge.zip",
        mimeType: "application/zip",
        size: String(MAX_FILE_BYTES + 1),
      }),
    );
    globalThis.fetch = fetchMock;

    const g = createGoogleWorkspace(token);
    await expect(g.drive.download("BIG")).rejects.toThrow(/too large/);
    expect(fetchMock.mock.calls.every(([u]) => !urlOf(u).includes("alt=media"))).toBe(true);
  });

  it("refuses an oversize export once the bytes arrive, since Google declares no size", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) =>
      urlOf(input).includes("/export")
        ? new Response(new Uint8Array(MAX_FILE_BYTES + 1), { status: 200 })
        : json({ id: "D1", name: "Report", mimeType: "application/vnd.google-apps.document" }),
    );

    const g = createGoogleWorkspace(token);
    await expect(g.drive.download("D1")).rejects.toThrow(/too large/);
  });

  it("says a download is blocked when the owner disabled it", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      json({
        id: "R1",
        name: "locked.pdf",
        mimeType: "application/pdf",
        size: "10",
        capabilities: { canDownload: false },
      }),
    );

    const g = createGoogleWorkspace(token);
    await expect(g.drive.download("R1")).rejects.toThrow(/disabled downloading/);
  });

  it("reports Google's own 10 MB export limit as its own failure, not as too large", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) =>
      urlOf(input).includes("/export")
        ? new Response(JSON.stringify({ error: { errors: [{ reason: "exportSizeLimitExceeded" }] } }), { status: 403 })
        : json({ id: "D1", name: "Report", mimeType: "application/vnd.google-apps.document" }),
    );

    const g = createGoogleWorkspace(token);
    await expect(g.drive.download("D1")).rejects.toThrow(/Google's own 10 MB export limit/);
  });

  it("upload opens a resumable session and PUTs the bytes to it", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = urlOf(input);
      calls.push({ url, method: init?.method, body: init?.body });
      if (url.includes("uploadType=resumable")) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://upload.example/session-1" },
        });
      }
      return json({ id: "U1", name: "notes.txt", mimeType: "text/plain", size: "5" });
    });

    const g = createGoogleWorkspace(token);
    const uploaded = await g.drive.upload({
      filename: "notes.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("hello"),
      folderId: "FOLDER1",
    });

    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body as string)).toEqual({
      name: "notes.txt",
      mimeType: "text/plain",
      parents: ["FOLDER1"],
    });
    expect(calls[1]).toMatchObject({
      url: "https://upload.example/session-1",
      method: "PUT",
    });
    expect(uploaded).toMatchObject({ id: "U1", name: "notes.txt", byteSize: 5 });
  });

  it("createFolder creates a folder inside its parent", async () => {
    let posted: unknown;
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(urlOf(input)).toContain("/drive/v3/files?");
      posted = JSON.parse((init as RequestInit).body as string);
      return json({
        id: "FOLDER2",
        name: "Receipts",
        mimeType: "application/vnd.google-apps.folder",
      });
    });

    const g = createGoogleWorkspace(token);
    const folder = await g.drive.createFolder({ name: "Receipts", parentId: "FOLDER1" });

    expect(posted).toEqual({
      name: "Receipts",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["FOLDER1"],
    });
    expect(folder).toMatchObject({ id: "FOLDER2", isFolder: true, byteSize: null });
  });

  it("trash and restore patch the trashed flag, never deleting", async () => {
    const seen: { method?: string; body?: unknown }[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      seen.push({ method: init?.method, body: init?.body });
      expect(urlOf(input)).toContain("/files/F1?");
      return json({ id: "F1", name: "old.pdf", mimeType: "application/pdf", size: "3" });
    });

    const g = createGoogleWorkspace(token);
    await g.drive.trash("F1");
    await g.drive.trash("F1", true);

    expect(seen.map((s) => s.method)).toEqual(["PATCH", "PATCH"]);
    expect(seen.map((s) => JSON.parse(s.body as string) as unknown)).toEqual([
      { trashed: true },
      { trashed: false },
    ]);
  });

  it("mints no token and throws when Google isn't connected", async () => {
    globalThis.fetch = vi.fn<typeof fetch>();
    const g = createGoogleWorkspace(async () => null);
    await expect(g.drive.search({ query: "x" })).rejects.toBeInstanceOf(
      GoogleNotConnectedError,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
