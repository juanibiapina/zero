// In-memory GoogleWorkspace adapter for tests. Returns canned threads/events and
// records sent mail and created events for assertions, mirroring
// createMemorySearch. Deterministic: reads ignore the query/window unless a
// filter is given, so agent loops are reproducible.

import type {
  CalendarEvent,
  CalendarSummary,
  CreateEventInput,
  GoogleWorkspace,
  ListEventsParams,
  MailThread,
  MailThreadSummary,
  SendMailInput,
} from "./types";
import { GoogleNotConnectedError } from "./types";

export interface MemoryGoogleSeed {
  threadSummaries?: MailThreadSummary[];
  threads?: Record<string, MailThread>;
  attachments?: Record<string, {
    filename: string;
    mimeType: string;
    declaredSize?: number;
    bytes: Uint8Array;
  }>;
  calendars?: CalendarSummary[];
  events?: CalendarEvent[];
  // When true, every method throws GoogleNotConnectedError (simulates a user
  // who hasn't connected Google).
  notConnected?: boolean;
}

export interface MemoryGoogle extends GoogleWorkspace {
  sentMail: SendMailInput[];
  createdEvents: { event: CreateEventInput; calendarId: string }[];
}

export const createMemoryGoogle = (
  seed: MemoryGoogleSeed = {},
): MemoryGoogle => {
  const sentMail: SendMailInput[] = [];
  const createdEvents: { event: CreateEventInput; calendarId: string }[] = [];

  const guard = () => {
    if (seed.notConnected) throw new GoogleNotConnectedError();
  };

  return {
    sentMail,
    createdEvents,
    mail: {
      async search(): Promise<MailThreadSummary[]> {
        guard();
        return seed.threadSummaries ?? [];
      },
      async getThread(threadId: string): Promise<MailThread> {
        guard();
        return (
          seed.threads?.[threadId] ?? { threadId, messages: [] }
        );
      },
      async downloadAttachment(messageId, partId) {
        guard();
        const attachment = seed.attachments?.[`${messageId}:${partId}`];
        if (!attachment) throw new Error("The Gmail attachment part is missing or changed.");
        return {
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          declaredSize: attachment.declaredSize ?? attachment.bytes.length,
          bytes: attachment.bytes.slice(),
        };
      },
      async send(input: SendMailInput): Promise<{ id: string }> {
        guard();
        sentMail.push(input);
        return { id: `sent-${sentMail.length}` };
      },
    },
    calendar: {
      async listCalendars(): Promise<CalendarSummary[]> {
        guard();
        return seed.calendars ?? [];
      },
      async listEvents(params: ListEventsParams): Promise<CalendarEvent[]> {
        guard();
        const all = seed.events ?? [];
        if (!params.calendarIds) return all;
        const wanted = new Set(params.calendarIds);
        return all.filter((e) => e.calendarId && wanted.has(e.calendarId));
      },
      async createEvent(
        event: CreateEventInput,
        calendarId = "primary",
      ): Promise<CalendarEvent> {
        guard();
        createdEvents.push({ event, calendarId });
        return {
          ...event,
          id: `evt-${createdEvents.length}`,
          calendarId,
        };
      },
    },
  };
};
