// Real GoogleWorkspace adapter: plain fetch against Gmail (gmail/v1) and
// Calendar (calendar/v3) REST APIs with a bearer token. A deep module — all
// REST, MIME, base64url, and multi-calendar fan-out detail lives here; the port
// exposes flat shapes only. See docs/google-tools.md.
//
// Takes a token PROVIDER (not a raw token) so a turn that never touches Google
// mints no token; the provider is memoized per turn by the DO. A null token
// means Google isn't connected and surfaces as GoogleNotConnectedError, which
// the tool layer turns into `{ error }` data.

import { MAX_FILE_BYTES, MAX_FILE_LABEL } from "../files/types";
import {
  CALENDAR_EVENTS_CAP,
  CALENDAR_PER_LIST_CAP,
  DRIVE_SEARCH_CAP,
  GoogleApiError,
  GoogleNotConnectedError,
  LISTED_SYSTEM_LABELS,
  MAIL_DRAFTS_CAP,
  MAIL_SEARCH_CAP,
  UNMODIFIABLE_LABELS,
  type CalendarApi,
  type CalendarEvent,
  type CalendarSummary,
  type CreateEventInput,
  type DriveApi,
  type DriveDownload,
  type DriveFile,
  type DriveSearchParams,
  type DriveUploadInput,
  type EventDateTime,
  type GoogleWorkspace,
  type ListEventsParams,
  type MailApi,
  type MailDraft,
  type MailDraftSummary,
  type MailLabel,
  type MailMessage,
  type MailThread,
  type MailThreadSummary,
  type SendMailInput,
} from "./types";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
// Uploads go to a different host path; the discovery document's
// "/resumable/upload/..." path is not a URL you call.
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const NATIVE_PREFIX = "application/vnd.google-apps.";

// Everything the port needs off a Drive file, in one `fields` mask. The default
// response carries only kind/id/name/mimeType, so this is not optional.
const DRIVE_FILE_FIELDS =
  "id,name,mimeType,size,modifiedTime,webViewLink,shortcutDetails,capabilities/canDownload";

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

const bytesFromBase64url = (b64: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(b64)) throw new Error("Malformed Gmail attachment data.");
  const unpadded = b64.replace(/=+$/, "");
  const norm = unpadded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - unpadded.length % 4) % 4);
  let bin: string;
  try {
    bin = atob(norm);
  } catch {
    throw new Error("Malformed Gmail attachment data.");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const stringFromBase64url = (b64: string): string =>
  new TextDecoder().decode(bytesFromBase64url(b64));

const attachmentSummaries = (part: GmailPart | undefined) => {
  const out: { partId: string; filename: string; mimeType: string; byteSize: number }[] = [];
  const visit = (node: GmailPart): void => {
    if (node.filename && node.partId) {
      out.push({
        partId: node.partId,
        filename: node.filename,
        mimeType: node.mimeType ?? "application/octet-stream",
        byteSize: node.body?.size ?? 0,
      });
    }
    for (const child of node.parts ?? []) visit(child);
  };
  if (part) visit(part);
  return out;
};

const findPartById = (part: GmailPart | undefined, partId: string): GmailPart | undefined => {
  if (!part) return undefined;
  if (part.partId === partId) return part;
  for (const child of part.parts ?? []) {
    const found = findPartById(child, partId);
    if (found) return found;
  }
  return undefined;
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

// The RFC-822 message Gmail wants, base64url-encoded into `raw`, plus the
// `threadId` that keeps a reply in its conversation. Shared by send and drafts:
// a draft that replies has to carry exactly the same three things as a sent
// reply (threadId in the JSON, In-Reply-To/References echoing the
// messageIdHeader, and a matching Subject), so there is one builder, not two.
const rawMessage = (input: SendMailInput): { raw: string; threadId?: string } => {
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
  return input.replyTo ? { raw, threadId: input.replyTo.threadId } : { raw };
};

// --- gmail payload types (partial) ---

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: GmailPart;
}

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
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

// --- Drive helpers ---

interface RawDriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  capabilities?: { canDownload?: boolean };
}

const toDriveFile = (raw: RawDriveFile): DriveFile => ({
  id: raw.id ?? "",
  name: raw.name ?? "(untitled)",
  mimeType: raw.mimeType ?? "application/octet-stream",
  // Google-native files report no size at all; a missing size is "unknown",
  // not zero.
  byteSize: raw.size === undefined ? null : Number(raw.size),
  modifiedAt: raw.modifiedTime ?? "",
  webViewLink: raw.webViewLink ?? null,
  isFolder: raw.mimeType === FOLDER_MIME,
});

// A search term goes inside single quotes in the `q` expression, so both the
// quote and the backslash have to be escaped or the query is malformed (or,
// worse, silently different).
const escapeQueryTerm = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// files.list returns trashed files by default, so `trashed` is always stated.
const buildDriveQuery = (params: DriveSearchParams): string => {
  const clauses = [`trashed = ${params.trashed ? "true" : "false"}`];
  if (params.query) {
    const term = escapeQueryTerm(params.query);
    clauses.push(`(name contains '${term}' or fullText contains '${term}')`);
  }
  if (params.mimeType) {
    clauses.push(`mimeType = '${escapeQueryTerm(params.mimeType)}'`);
  }
  if (params.folderId) {
    clauses.push(`'${escapeQueryTerm(params.folderId)}' in parents`);
  }
  return clauses.join(" and ");
};

const isNative = (mimeType: string): boolean =>
  mimeType.startsWith(NATIVE_PREFIX);

// How a Google-native document leaves Drive. Docs and Slides become PDFs so
// read_pdf can page through them; a Sheet has no PDF worth reading, so it
// becomes CSV. Everything else (Forms, Sites, Vids, ...) has no useful export.
const EXPORT_AS_BYTES: Record<string, string> = {
  "application/vnd.google-apps.document": "application/pdf",
  "application/vnd.google-apps.presentation": "application/pdf",
  "application/vnd.google-apps.drawing": "application/pdf",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "text/csv": ".csv",
  "text/plain": ".txt",
};

const withExtension = (name: string, mimeType: string): string => {
  const ext = EXTENSIONS[mimeType];
  if (!ext) return name;
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
};

// Google's own export limits are not caps Zero chooses, so they get their own
// message: telling a user to shrink a file to fit a 10 MB export limit they
// cannot see would be useless advice.
const describeExportFailure = (error: unknown, name: string): unknown => {
  if (!(error instanceof GoogleApiError)) return error;
  if (error.message.includes("exportSizeLimitExceeded")) {
    return new Error(
      `Google could not export "${name}": it is over Google's own 10 MB export limit. Ask for a smaller part of it.`,
    );
  }
  if (error.message.includes("fileNotExportable")) {
    return new Error(
      `Google does not allow exporting "${name}" (Google Vids files, for example), so Zero cannot read it.`,
    );
  }
  return error;
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
        throw new GoogleApiError(
          res.status,
          `Google auth failed (401): token expired or scope missing. ${detail}`.trim(),
        );
      }
      throw new GoogleApiError(
        res.status,
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

  // --- label name ↔ id ---
  //
  // The port speaks label NAMES; Gmail speaks ids. System labels are their own
  // id ("INBOX"), user labels are "Label_12"-shaped, and nesting is spelled
  // "Parent/Child" in the name. The list is fetched at most once per adapter
  // instance (one per turn), so a turn that files three threads pays for one
  // labels.list.
  let labelCache: GmailLabel[] | null = null;
  const allLabels = async (): Promise<GmailLabel[]> => {
    labelCache ??= (
      await getJson<{ labels?: GmailLabel[] }>(`${GMAIL_BASE}/labels`)
    ).labels ?? [];
    return labelCache;
  };

  const labelIdFor = async (name: string): Promise<string> => {
    const upper = name.toUpperCase();
    if ((UNMODIFIABLE_LABELS as readonly string[]).includes(upper)) {
      throw new Error(
        `Gmail does not allow adding or removing the ${upper} label, and labels cannot be applied to drafts.`,
      );
    }
    const labels = await allLabels();
    const match = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (match) return match.id;
    const known = labels
      .filter((l) => l.type !== "system")
      .map((l) => l.name)
      .join(", ");
    throw new Error(
      `No Gmail label named "${name}". Existing labels: ${known || "(none)"}. Create it first if that is what you meant.`,
    );
  };

  const labelNamesFor = async (ids: string[]): Promise<string[]> => {
    const labels = await allLabels();
    return ids.map((id) => labels.find((l) => l.id === id)?.name ?? id);
  };

  const toMailLabel = (l: GmailLabel): MailLabel => ({
    name: l.name,
    type: l.type === "system" ? "system" : "user",
  });

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
          attachments: attachmentSummaries(m.payload),
        };
      });
      return { threadId, messages };
    },

    async downloadAttachment(messageId, partId) {
      const message = await getJson<GmailMessage>(
        `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`,
      );
      const part = findPartById(message.payload, partId);
      if (!part || !part.filename) {
        throw new Error("The Gmail attachment part is missing or changed.");
      }
      const declaredSize = part.body?.size ?? 0;
      if (declaredSize > MAX_FILE_BYTES) {
        throw new Error(`That Gmail attachment is too large (over ${MAX_FILE_LABEL}).`);
      }
      let data = part.body?.data;
      if (!data) {
        const attachmentId = part.body?.attachmentId;
        if (!attachmentId) throw new Error("The Gmail attachment has no downloadable data.");
        const body = await getJson<{ data?: string; size?: number }>(
          `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        );
        const endpointSize = body.size ?? declaredSize;
        if (endpointSize > MAX_FILE_BYTES) {
          throw new Error(`That Gmail attachment is too large (over ${MAX_FILE_LABEL}).`);
        }
        if (endpointSize !== declaredSize) {
          throw new Error("The Gmail attachment size changed while downloading.");
        }
        data = body.data;
      }
      if (!data) throw new Error("The Gmail attachment has no downloadable data.");
      const bytes = bytesFromBase64url(data);
      if (bytes.length > MAX_FILE_BYTES) {
        throw new Error(`That Gmail attachment is too large (over ${MAX_FILE_LABEL}).`);
      }
      if (declaredSize !== bytes.length) {
        throw new Error("The Gmail attachment size changed while downloading.");
      }
      return {
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        declaredSize,
        bytes,
      };
    },

    async send(input: SendMailInput): Promise<{ id: string }> {
      const body = rawMessage(input);

      const res = await authFetch(`${GMAIL_BASE}/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const sent = await readJson<{ id: string }>(res);
      return { id: sent.id };
    },

    async listLabels(): Promise<MailLabel[]> {
      const labels = await allLabels();
      return labels
        .filter(
          (l) =>
            l.type !== "system" ||
            (LISTED_SYSTEM_LABELS as readonly string[]).includes(l.id),
        )
        .map(toMailLabel);
    },

    async createLabel(name: string): Promise<MailLabel> {
      const res = await authFetch(`${GMAIL_BASE}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const created = await readJson<GmailLabel>(res);
      // The cached list is now stale, and the very next call is usually a
      // modify with this label.
      labelCache = null;
      return toMailLabel(created);
    },

    async renameLabel(name: string, newName: string): Promise<MailLabel> {
      const id = await labelIdFor(name);
      const res = await authFetch(`${GMAIL_BASE}/labels/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      const updated = await readJson<GmailLabel>(res);
      labelCache = null;
      return toMailLabel(updated);
    },

    async modifyThread({ threadId, add, remove }) {
      const addLabelIds = await Promise.all((add ?? []).map(labelIdFor));
      const removeLabelIds = await Promise.all((remove ?? []).map(labelIdFor));
      const res = await authFetch(
        `${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}/modify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addLabelIds, removeLabelIds }),
        },
      );
      // The response is the thread; a label may sit on some messages and not
      // others, so report the union, which is what Gmail's own UI shows.
      const thread = await readJson<{ messages?: { labelIds?: string[] }[] }>(res);
      const ids = new Set<string>();
      for (const m of thread.messages ?? []) for (const id of m.labelIds ?? []) ids.add(id);
      return { threadId, labels: await labelNamesFor([...ids]) };
    },

    async trashThread(threadId: string): Promise<void> {
      await authFetch(`${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}/trash`, {
        method: "POST",
      });
    },

    async untrashThread(threadId: string): Promise<void> {
      await authFetch(`${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}/untrash`, {
        method: "POST",
      });
    },

    async listDrafts(): Promise<MailDraftSummary[]> {
      // drafts.list has no `format`: it returns ids only. To/Subject cost one
      // metadata GET each, same fan-out as search.
      const list = await getJson<{ drafts?: { id: string }[] }>(
        `${GMAIL_BASE}/drafts?maxResults=${MAIL_DRAFTS_CAP}`,
      );
      const drafts = (list.drafts ?? []).slice(0, MAIL_DRAFTS_CAP);
      return Promise.all(
        drafts.map(async (d) => {
          const full = await getJson<{ message?: GmailMessage }>(
            `${GMAIL_BASE}/drafts/${encodeURIComponent(d.id)}?format=metadata` +
              "&metadataHeaders=To&metadataHeaders=Subject",
          );
          const headers = full.message?.payload?.headers;
          return {
            draftId: d.id,
            to: findHeader(headers, "To") ?? "",
            subject: findHeader(headers, "Subject") ?? "",
            snippet: full.message?.snippet ?? "",
          } satisfies MailDraftSummary;
        }),
      );
    },

    async saveDraft(input): Promise<MailDraft> {
      // Gmail cannot edit a draft's message, only replace it: the draft id is
      // stable, the message id inside it changes on every update. So an update
      // is a PUT of a whole new message, never a patch.
      const message = rawMessage(input);
      const url = input.draftId
        ? `${GMAIL_BASE}/drafts/${encodeURIComponent(input.draftId)}`
        : `${GMAIL_BASE}/drafts`;
      const res = await authFetch(url, {
        method: input.draftId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const draft = await readJson<{ id: string; message?: { threadId?: string } }>(res);
      return { draftId: draft.id, threadId: draft.message?.threadId ?? null };
    },

    async sendDraft(draftId: string): Promise<{ id: string }> {
      const res = await authFetch(`${GMAIL_BASE}/drafts/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draftId }),
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

  // --- Drive ---

  const driveFileParams = (extra: Record<string, string> = {}) =>
    new URLSearchParams({
      fields: DRIVE_FILE_FIELDS,
      supportsAllDrives: "true",
      ...extra,
    }).toString();

  const rawDriveFile = (fileId: string): Promise<RawDriveFile> =>
    getJson<RawDriveFile>(
      `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?${driveFileParams()}`,
    );

  // A shortcut is a file whose content lives elsewhere. Resolving it costs one
  // request, so it happens only when the bytes or the text are actually wanted
  // — never per search hit, where shortcutDetails already rides along.
  const resolveTarget = async (fileId: string): Promise<RawDriveFile> => {
    const raw = await rawDriveFile(fileId);
    const targetId = raw.shortcutDetails?.targetId;
    if (raw.mimeType === SHORTCUT_MIME && targetId) {
      return rawDriveFile(targetId);
    }
    return raw;
  };

  const exportBytes = async (
    raw: RawDriveFile,
    exportMime: string,
  ): Promise<Uint8Array> => {
    const url =
      `${DRIVE_BASE}/files/${encodeURIComponent(raw.id ?? "")}/export` +
      `?mimeType=${encodeURIComponent(exportMime)}`;
    let res: Response;
    try {
      res = await authFetch(url);
    } catch (error) {
      throw describeExportFailure(error, raw.name ?? "that file");
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Exports declare no size up front, so this is the only size check there is.
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error(`That Drive file is too large (over ${MAX_FILE_LABEL}).`);
    }
    return bytes;
  };

  const mediaBytes = async (raw: RawDriveFile): Promise<Uint8Array> => {
    if (raw.capabilities?.canDownload === false) {
      throw new Error(
        `The owner of "${raw.name ?? "that file"}" has disabled downloading it.`,
      );
    }
    const declared = raw.size === undefined ? 0 : Number(raw.size);
    if (declared > MAX_FILE_BYTES) {
      throw new Error(`That Drive file is too large (over ${MAX_FILE_LABEL}).`);
    }
    const res = await authFetch(
      `${DRIVE_BASE}/files/${encodeURIComponent(raw.id ?? "")}?alt=media&supportsAllDrives=true`,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error(`That Drive file is too large (over ${MAX_FILE_LABEL}).`);
    }
    return bytes;
  };

  const drive: DriveApi = {
    async search(params: DriveSearchParams): Promise<DriveFile[]> {
      const query = new URLSearchParams({
        q: buildDriveQuery(params),
        pageSize: String(DRIVE_SEARCH_CAP),
        orderBy: "modifiedTime desc",
        fields: `files(${DRIVE_FILE_FIELDS})`,
        // Without both of these a user's shared-drive files are invisible.
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: "allDrives",
      });
      const data = await getJson<{ files?: RawDriveFile[] }>(
        `${DRIVE_BASE}/files?${query.toString()}`,
      );
      // nextPageToken is deliberately not followed: same bounded-list policy as
      // Gmail search and Calendar events.
      return (data.files ?? []).slice(0, DRIVE_SEARCH_CAP).map(toDriveFile);
    },

    async get(fileId: string): Promise<DriveFile> {
      return toDriveFile(await resolveTarget(fileId));
    },

    async download(fileId: string): Promise<DriveDownload> {
      const raw = await resolveTarget(fileId);
      const file = toDriveFile(raw);
      if (file.isFolder) {
        throw new Error(`"${file.name}" is a folder, not a file.`);
      }
      if (isNative(file.mimeType)) {
        const exportMime = EXPORT_AS_BYTES[file.mimeType];
        if (!exportMime) {
          throw new Error(
            `Google does not allow exporting "${file.name}" (${file.mimeType}).`,
          );
        }
        return {
          filename: withExtension(file.name, exportMime),
          mimeType: exportMime,
          bytes: await exportBytes(raw, exportMime),
        };
      }
      return {
        filename: file.name,
        mimeType: file.mimeType,
        bytes: await mediaBytes(raw),
      };
    },

    async upload(input: DriveUploadInput): Promise<DriveFile> {
      // Resumable, not multipart: Google documents multipart for files of 5 MB
      // or less, and a Zero file can be 20 MB. Two requests for any size.
      const metadata = {
        name: input.filename,
        mimeType: input.mimeType,
        ...(input.folderId ? { parents: [input.folderId] } : {}),
      };
      const start = await authFetch(
        `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&${driveFileParams()}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(metadata),
        },
      );
      const session = start.headers.get("location");
      if (!session) {
        throw new Error("Drive did not open an upload session.");
      }
      const res = await authFetch(session, {
        method: "PUT",
        headers: { "Content-Type": input.mimeType },
        body: input.bytes,
      });
      const created = await readJson<RawDriveFile>(res);
      return toDriveFile({ ...metadata, ...created });
    },

    async createFolder({ name, parentId }): Promise<DriveFile> {
      const res = await authFetch(
        `${DRIVE_BASE}/files?${driveFileParams()}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            mimeType: FOLDER_MIME,
            ...(parentId ? { parents: [parentId] } : {}),
          }),
        },
      );
      return toDriveFile(await readJson<RawDriveFile>(res));
    },

    async trash(fileId: string, restore = false): Promise<DriveFile> {
      // files.delete is permanent and is deliberately never called.
      const res = await authFetch(
        `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?${driveFileParams()}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trashed: !restore }),
        },
      );
      return toDriveFile(await readJson<RawDriveFile>(res));
    },
  };

  return { mail, calendar, drive };
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
