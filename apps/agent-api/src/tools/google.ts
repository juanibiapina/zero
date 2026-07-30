// Gmail + Calendar tools for the interface agent, built over the GoogleWorkspace
// port. Reads need no confirmation; gmail_send and calendar_create_event are
// side-effecting and gated by the prompt's confirmation policy. Failures come
// back as `{ error }` data (never thrown) so the model can react — a
// GoogleNotConnectedError becomes the "connect it in the Zero app" message.
//
// Calendar tools close over the user's IANA timezone (already threaded to the
// interface agent) so the model supplies local wall-clock times and the tool
// stamps the zone. See docs/google-tools.md.

import { defineTool, type AgentToolSet } from "../agents/protocol";
import { z } from "zod";
import { log } from "../log";
import {
  ExternalCallNotSent,
  isProvableRejection,
} from "../agents/external-call";
import {
  CALENDAR_EVENTS_CAP,
  GoogleApiError,
  GoogleNotConnectedError,
  MAIL_SEARCH_CAP,
  type CreateEventInput,
  type EventDateTime,
  type GoogleWorkspace,
} from "../google/types";

export interface GoogleToolsDeps {
  google: GoogleWorkspace;
  // The user's IANA timezone; calendar tools stamp it onto wall-clock times.
  timezone: string;
}

// Run an adapter call, converting a not-connected error into a friendly message
// and any other failure into logged `{ error }` data.
const guard = async <T>(
  op: string,
  fn: () => Promise<T>,
): Promise<T | { error: string }> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GoogleNotConnectedError) {
      return { error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`${op}_failed`, { error: message });
    return { error: message };
  }
};

// The guard for the two irreversible tools. It must not turn every failure into
// data: swallowing an ambiguous error would let the model retry under a new
// tool_use id and send the same mail twice. Only a provable non-effect is
// reported as a normal failure; anything else propagates, and agents/run.ts
// leaves the call's claim in flight and tells the model the outcome is unknown.
const writeGuard = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`${op}_failed`, { error: message });
    if (err instanceof GoogleNotConnectedError)
      throw new ExternalCallNotSent(err.message);
    if (err instanceof GoogleApiError && isProvableRejection(err.status))
      throw new ExternalCallNotSent(message);
    throw err;
  }
};

// A bare date (YYYY-MM-DD) becomes an all-day boundary; a datetime gets seconds
// appended if missing. Returned value is a local wall-clock string with no
// offset (the caller pairs it with the IANA timeZone).
const normalizeWallClock = (value: string, endOfDay: boolean): string => {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T${endOfDay ? "23:59:59" : "00:00:00"}`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return `${v}:00`;
  return v;
};

// Offset string ("+02:00") for an IANA zone at roughly the given wall-clock.
// The wall-clock is read as UTC to get an approximate instant; the resulting
// offset is correct except within the ~1h DST transition window.
const zoneOffset = (wallClock: string, timeZone: string): string => {
  const approx = new Date(`${wallClock}Z`);
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(approx)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return "+00:00";
  return `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}`;
};

// Resolve a local wall-clock (date or datetime) to an RFC-3339 timestamp with
// the zone's offset, for Calendar timeMin/timeMax.
const toRfc3339 = (value: string, timeZone: string, endOfDay: boolean): string => {
  const local = normalizeWallClock(value, endOfDay);
  return `${local}${zoneOffset(local, timeZone)}`;
};

export const buildGoogleTools = (deps: GoogleToolsDeps): AgentToolSet => {
  const { google, timezone } = deps;

  return {
    gmail_search: defineTool({
      description:
        "Search the user's Gmail with Gmail query syntax (e.g. " +
        '"from:alice newer_than:7d"). Returns matching threads with threadId, ' +
        "date, sender, subject, and a snippet. Read-only.",
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) =>
        guard("gmail_search", async () => {
          const threads = await google.mail.search(query);
          return { threads, truncated: threads.length >= MAIL_SEARCH_CAP };
        }),
    }),

    gmail_thread: defineTool({
      description:
        "Read a full Gmail thread by threadId (from gmail_search). Returns each " +
        "message with its Gmail id, RFC-822 Message-ID header, From/To/Subject/" +
        "Date, and decoded body. Needed before replying: copy messageIdHeader " +
        "and threadId into gmail_send's replyTo.",
      inputSchema: z.object({ threadId: z.string() }),
      execute: ({ threadId }) =>
        guard("gmail_thread", () => google.mail.getThread(threadId)),
    }),

    gmail_send: defineTool({
      description:
        "Send an email, or reply in a thread. Only call after the user has " +
        "confirmed the exact recipients, subject, and body. For a reply, pass " +
        "replyTo with the messageIdHeader and threadId from a gmail_thread " +
        "result, and use the original subject prefixed with 'Re:' so the reply " +
        "stays in the thread.",
      inputSchema: z.object({
        to: z.string(),
        subject: z.string(),
        body: z.string(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        replyTo: z
          .object({ messageIdHeader: z.string(), threadId: z.string() })
          .optional(),
      }),
      execute: (input) => writeGuard("gmail_send", () => google.mail.send(input)),
      // Irreversible: once the mail leaves there is no unsend, so a resumed turn
      // must never fire this twice (see agents/run.ts).
      externalWrite: true,
    }),

    calendar_list_calendars: defineTool({
      description:
        "List the user's calendars (id, summary, whether primary, accessRole). " +
        "Use to name a calendar or pick a calendarId when the user means a " +
        "non-primary calendar. Read-only.",
      inputSchema: z.object({}),
      execute: () =>
        guard("calendar_list_calendars", () => google.calendar.listCalendars()),
    }),

    calendar_list_events: defineTool({
      description:
        "List calendar events in a window across ALL the user's calendars by " +
        "default (each event tagged with its calendar), or a subset via " +
        "calendarIds. `from`/`to` are LOCAL wall-clock — a date (YYYY-MM-DD) or " +
        "datetime (YYYY-MM-DDTHH:MM) in the user's timezone; the tool applies " +
        "the zone. Recurring events are expanded into instances. Read-only.",
      inputSchema: z.object({
        from: z.string().describe("Local date or datetime, e.g. 2026-07-17 or 2026-07-17T09:00"),
        to: z.string().describe("Local date or datetime"),
        query: z.string().optional(),
        calendarIds: z.array(z.string()).optional(),
      }),
      execute: ({ from, to, query, calendarIds }) =>
        guard("calendar_list_events", async () => {
          const events = await google.calendar.listEvents({
            from: toRfc3339(from, timezone, false),
            to: toRfc3339(to, timezone, true),
            query,
            calendarIds,
          });
          return {
            events,
            truncated: events.length >= CALENDAR_EVENTS_CAP,
          };
        }),
    }),

    calendar_create_event: defineTool({
      description:
        "Create a calendar event on calendarId (default 'primary'). Only call " +
        "after the user confirms the time (restated with its timezone), title, " +
        "and calendar. `start`/`end` are LOCAL wall-clock in the user's " +
        "timezone (date for allDay, else datetime); the tool stamps the zone.",
      inputSchema: z.object({
        summary: z.string(),
        start: z.string(),
        end: z.string(),
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z.array(z.string()).optional(),
        allDay: z.boolean().optional(),
        calendarId: z.string().optional(),
      }),
      execute: ({ summary, start, end, description, location, attendees, allDay, calendarId }) =>
        writeGuard("calendar_create_event", () => {
          const toDateTime = (v: string): EventDateTime =>
            allDay
              ? { date: normalizeWallClock(v, false).slice(0, 10) }
              : { dateTime: normalizeWallClock(v, false), timeZone: timezone };
          const event: CreateEventInput = {
            summary,
            description,
            location,
            attendees,
            start: toDateTime(start),
            end: toDateTime(end),
          };
          return google.calendar.createEvent(event, calendarId);
        }),
      // Irreversible: a duplicate event is visible to every attendee.
      externalWrite: true,
    }),
  };
};
