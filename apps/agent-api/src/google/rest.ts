// Real GoogleWorkspace adapter: plain fetch against Gmail (gmail/v1) and
// Calendar (calendar/v3) REST APIs with a bearer token. A deep module — all
// REST, MIME, base64url, and multi-calendar fan-out detail lives here; the port
// exposes flat shapes only. See docs/google-tools.md.
//
// Takes a token PROVIDER (not a raw token) so a turn that never touches Google
// mints no token; the provider is memoized per turn by the DO. A null token
// means Google isn't connected and surfaces as GoogleNotConnectedError, which
// the tool layer turns into `{ error }` data.

import {
  CALENDAR_EVENTS_CAP,
  CALENDAR_PER_LIST_CAP,
  GoogleNotConnectedError,
  MAIL_SEARCH_CAP,
  type CalendarApi,
  type CalendarEvent,
  type CalendarSummary,
  type CreateEventInput,
  type EventDateTime,
  type GoogleWorkspace,
  type ListEventsParams,
  type MailApi,
  type MailMessage,
  type MailThread,
  type MailThreadSummary,
  type SendMailInput,
} from "./types";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

export type TokenProvider = () => Promise<string | null>;

// --- base64url / base64 helpers (UTF-8 safe) ---

const bytesToBinary = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return bin;
};

const base64FromString = (s: string): string =>
  btoa(bytesToBinary(new TextEncoder().encode(s)));

const base64urlFromString = (s: string): string =>
  base64FromString(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const stringFromBase64url = (b64: string): string => {
  const norm = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
};

// RFC 2047 encoded-word for a non-ASCII header value (Subject).
const encodeHeaderWord = (value: string): string =>
  isAscii(value) ? value : `=?UTF-8?B?${base64FromString(value)}?=`;

// --- gmail payload types (partial) ---

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  payload?: GmailPart;
}

// Case-insensitive header lookup. Gmail returns `Message-ID` (capital ID) but
// casing varies by sender (`Message-Id`), so never match on exact case.
const findHeader = (
  headers: GmailHeader[] | undefined,
  name: string,
): string | null => {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
};

// Walk the MIME part tree (recursively — multipart/mixed can wrap
// multipart/alternative) and return the decoded body, preferring text/plain and
// falling back to a crudely-stripped text/html.
const extractBody = (part: GmailPart | undefined): string => {
  if (!part) return "";
  const plain = findPartByType(part, "text/plain");
  if (plain?.body?.data) return stringFromBase64url(plain.body.data);
  const html = findPartByType(part, "text/html");
  if (html?.body?.data) {
    return stripHtml(stringFromBase64url(html.body.data));
  }
  // Single-part message with an inline body and no explicit text/* wrapper.
  if (part.body?.data) return stringFromBase64url(part.body.data);
  return "";
};

const findPartByType = (
  part: GmailPart,
  mimeType: string,
): GmailPart | undefined => {
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPartByType(child, mimeType);
    if (found) return found;
  }
  return undefined;
};

const stripHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// --- start/end mapping for calendar events ---

interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

const toEventDateTime = (v: GoogleEventDateTime | undefined): EventDateTime => {
  if (v?.date) return { date: v.date };
  return { dateTime: v?.dateTime ?? "", timeZone: v?.timeZone ?? "UTC" };
};

const startInstant = (e: CalendarEvent): number => {
  const s = e.start;
  const iso = "date" in s ? s.date : s.dateTime;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

export const createGoogleWorkspace = (
  getToken: TokenProvider,
): GoogleWorkspace => {
  const authFetch = async (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const token = await getToken();
    if (!token) throw new GoogleNotConnectedError();
    const res = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 401) {
        throw new Error(
          `Google auth failed (401): token expired or scope missing. ${detail}`.trim(),
        );
      }
      throw new Error(
        `Google API ${res.status} ${res.statusText}: ${detail}`.trim(),
      );
    }
    return res;
  };

  const readJson = async <T>(res: Response): Promise<T> => {
    const data: T = await res.json();
    return data;
  };
  const getJson = async <T>(url: string): Promise<T> =>
    readJson<T>(await authFetch(url));

  const mail: MailApi = {
    async search(query: string): Promise<MailThreadSummary[]> {
      const url = `${GMAIL_BASE}/threads?q=${encodeURIComponent(query)}&maxResults=${MAIL_SEARCH_CAP}`;
      const list = await getJson<{
        threads?: { id: string; snippet?: string }[];
      }>(url);
      const threads = list.threads ?? [];

      const summaries = await Promise.all(
        threads.map(async (t) => {
          const metaUrl =
            `${GMAIL_BASE}/threads/${t.id}?format=metadata` +
            "&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date";
          const thread = await getJson<{ messages?: GmailMessage[] }>(metaUrl);
          const msgs = thread.messages ?? [];
          const last = msgs[msgs.length - 1];
          const headers = last?.payload?.headers;
          return {
            threadId: t.id,
            date: findHeader(headers, "Date") ?? "",
            from: findHeader(headers, "From") ?? "",
            subject: findHeader(headers, "Subject") ?? "",
            snippet: t.snippet ?? "",
          } satisfies MailThreadSummary;
        }),
      );
      return summaries;
    },

    async getThread(threadId: string): Promise<MailThread> {
      const url = `${GMAIL_BASE}/threads/${threadId}?format=full`;
      const thread = await getJson<{ messages?: GmailMessage[] }>(url);
      const messages: MailMessage[] = (thread.messages ?? []).map((m) => {
        const headers = m.payload?.headers;
        return {
          id: m.id,
          threadId: m.threadId,
          messageIdHeader: findHeader(headers, "Message-ID"),
          from: findHeader(headers, "From") ?? "",
          to: findHeader(headers, "To") ?? "",
          subject: findHeader(headers, "Subject") ?? "",
          date: findHeader(headers, "Date") ?? "",
          body: extractBody(m.payload),
        };
      });
      return { threadId, messages };
    },

    async send(input: SendMailInput): Promise<{ id: string }> {
      const lines: string[] = [];
      lines.push(`To: ${input.to}`);
      if (input.cc) lines.push(`Cc: ${input.cc}`);
      if (input.bcc) lines.push(`Bcc: ${input.bcc}`);
      lines.push(`Subject: ${encodeHeaderWord(input.subject)}`);
      if (input.replyTo) {
        lines.push(`In-Reply-To: ${input.replyTo.messageIdHeader}`);
        lines.push(`References: ${input.replyTo.messageIdHeader}`);
      }
      lines.push("MIME-Version: 1.0");
      lines.push('Content-Type: text/plain; charset="UTF-8"');
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      // base64 body, wrapped to 76-char lines per RFC 2045.
      lines.push(base64FromString(input.body).replace(/(.{76})/g, "$1\r\n"));
      const raw = base64urlFromString(lines.join("\r\n"));

      const body: { raw: string; threadId?: string } = { raw };
      if (input.replyTo) body.threadId = input.replyTo.threadId;

      const res = await authFetch(`${GMAIL_BASE}/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const sent = await readJson<{ id: string }>(res);
      return { id: sent.id };
    },
  };

  const listCalendars = async (): Promise<CalendarSummary[]> => {
    const url = `${CALENDAR_BASE}/users/me/calendarList`;
    const data = await getJson<{
      items?: {
        id: string;
        summary?: string;
        primary?: boolean;
        accessRole?: string;
      }[];
    }>(url);
    return (data.items ?? []).map((c) => ({
      id: c.id,
      summary: c.summary ?? c.id,
      primary: !!c.primary,
      accessRole: c.accessRole ?? "none",
    }));
  };

  // Which calendars to query: an explicit subset, or every calendar with at
  // least reader access.
  const resolveCalendars = async (
    calendarIds?: string[],
  ): Promise<CalendarSummary[]> => {
    const all = await listCalendars();
    if (calendarIds) {
      const wanted = new Set(calendarIds);
      return all.filter((c) => wanted.has(c.id));
    }
    return all.filter(
      (c) => c.accessRole !== "none" && c.accessRole !== "freeBusyReader",
    );
  };

  const calendar: CalendarApi = {
    listCalendars,

    async listEvents(params: ListEventsParams): Promise<CalendarEvent[]> {
      const calendars = await resolveCalendars(params.calendarIds);

      const perCalendar = await Promise.all(
        calendars.map((cal) => listOneCalendar(getJson, cal, params)),
      );

      const merged = perCalendar
        .flat()
        .sort((a, b) => startInstant(a) - startInstant(b));
      return merged.slice(0, CALENDAR_EVENTS_CAP);
    },

    async createEvent(
      event: CreateEventInput,
      calendarId = "primary",
    ): Promise<CalendarEvent> {
      const body = {
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: event.start,
        end: event.end,
        attendees: event.attendees?.map((email) => ({ email })),
      };
      const res = await authFetch(
        `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const created = await readJson<{
        id?: string;
        summary?: string;
        description?: string;
        location?: string;
        start?: GoogleEventDateTime;
        end?: GoogleEventDateTime;
      }>(res);
      return {
        id: created.id,
        summary: created.summary ?? event.summary,
        description: created.description,
        location: created.location,
        start: toEventDateTime(created.start),
        end: toEventDateTime(created.end),
        calendarId,
      };
    },
  };

  return { mail, calendar };
};

// One events.list against a single calendar. Always singleEvents=true +
// orderBy=startTime so a recurring series arrives expanded into dated instances.
// Bounded by CALENDAR_PER_LIST_CAP; nextPageToken is not followed.
const listOneCalendar = async (
  getJson: <T>(url: string) => Promise<T>,
  cal: CalendarSummary,
  params: ListEventsParams,
): Promise<CalendarEvent[]> => {
  const q = new URLSearchParams({
    timeMin: params.from,
    timeMax: params.to,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(CALENDAR_PER_LIST_CAP),
  });
  if (params.query) q.set("q", params.query);
  const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(cal.id)}/events?${q.toString()}`;
  const data = await getJson<{
    items?: {
      id?: string;
      summary?: string;
      description?: string;
      location?: string;
      start?: GoogleEventDateTime;
      end?: GoogleEventDateTime;
      attendees?: { email?: string }[];
    }[];
  }>(url);
  return (data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary ?? "(no title)",
    description: e.description,
    location: e.location,
    start: toEventDateTime(e.start),
    end: toEventDateTime(e.end),
    attendees: e.attendees
      ?.map((a) => a.email)
      .filter((x): x is string => !!x),
    calendarId: cal.id,
    calendarSummary: cal.summary,
  }));
};
