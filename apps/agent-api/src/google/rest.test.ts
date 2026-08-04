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
