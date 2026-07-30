import { describe, expect, it } from "vitest";
import { buildGoogleTools } from "./google";
import { createMemoryGoogle } from "../google/memory";
import { GoogleApiError, GoogleNotConnectedError } from "../google/types";
import { ExternalCallNotSent } from "../agents/external-call";

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

  it("surfaces GoogleNotConnectedError as { error } data, not a throw", async () => {
    const google = createMemoryGoogle({ notConnected: true });
    const tools = buildGoogleTools({ google, timezone: "UTC" });
    const res = (await run(tools, "gmail_search", { query: "x" })) as {
      error: string;
    };
    expect(res.error).toContain("connect");
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
