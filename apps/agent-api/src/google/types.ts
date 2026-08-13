// Google Workspace port (a true-external seam), mirroring the WebSearch port.
// Callers depend only on this interface; a REST adapter (google/rest.ts) serves
// production and an in-memory adapter (google/memory.ts) serves tests. Payloads
// are normalized to small flat shapes so a field the model never needs never
// reaches it, and a provider swap stays local.
//
// Three sub-APIs are grouped under one GoogleWorkspace: `mail` (Gmail),
// `calendar` and `drive`. See docs/google-tools.md.

// Result caps. The adapter bounds every list to a most-recent slice and does
// not follow nextPageToken; the tool layer flags truncation (length >= cap) so
// the model can narrow the query. Shared here so adapter and tool agree.
export const MAIL_SEARCH_CAP = 20;
// drafts.list returns bare ids (no `format` parameter, and the Draft it returns
// carries only message id/threadId), so filling in To/Subject costs one
// metadata GET per draft. Same N+1 as search, so the same bound.
export const MAIL_DRAFTS_CAP = 20;
export const CALENDAR_EVENTS_CAP = 50;
// Per-calendar cap for the multi-calendar fan-out in listEvents.
export const CALENDAR_PER_LIST_CAP = 25;
export const DRIVE_SEARCH_CAP = 20;

// Thrown by the REST adapter when the token provider yields null (Google not
// connected, or a Clerk outage). The tool layer converts it to `{ error }` data
// rather than letting it throw, mirroring the web-search error-as-data pattern.
export class GoogleNotConnectedError extends Error {
  constructor(
    message = "Google isn't connected. Ask the user to connect it in the Zero app.",
  ) {
    super(message);
    this.name = "GoogleNotConnectedError";
  }
}

// A non-2xx response from the Google API. Carries the status because that is
// what decides whether a failed irreversible call provably did nothing (a
// rejection) or may have taken effect (a timeout, a throttle, a 5xx). See
// agents/external-call.ts.
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

// --- Gmail ---

// A single hit from a Gmail search: enough to name a thread, not its bodies.
export interface MailThreadSummary {
  threadId: string;
  date: string;
  from: string;
  subject: string;
  snippet: string;
}

// One message inside a thread. Three distinct id spaces (see docs): `id` is the
// opaque Gmail message handle; `messageIdHeader` is the RFC-822 `Message-ID`
// header that In-Reply-To/References must echo to make a proper reply.
export interface MailAttachmentSummary {
  partId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
}

export interface MailMessage {
  id: string;
  threadId: string;
  messageIdHeader: string | null;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  attachments: MailAttachmentSummary[];
}

export interface MailThread {
  threadId: string;
  messages: MailMessage[];
}

// Reply linkage copied verbatim from a prior getThread result. Carries the
// RFC-822 Message-ID header (for In-Reply-To/References) AND the threadId (to
// keep the sent message in the same conversation) — never the Gmail message id.
export interface MailReplyTo {
  messageIdHeader: string;
  threadId: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyTo?: MailReplyTo;
}

// A Gmail label as the model sees it: by NAME. The Gmail id (`Label_12`) never
// leaves the adapter — a model cannot invent one, and every tool input is a
// name that a user could have typed.
export interface MailLabel {
  name: string;
  type: "system" | "user";
}

// A draft in a list. `draftId` is stable across updates; the message inside it
// is replaced (and re-identified) on every update, which is why no message id
// is exposed here.
export interface MailDraftSummary {
  draftId: string;
  to: string;
  subject: string;
  snippet: string;
}

export interface MailDraft {
  draftId: string;
  threadId: string | null;
}

// Label names Gmail refuses to add or remove: it answers `400 Invalid label:
// SENT`, and labels cannot be applied to draft messages at all. Rejected in the
// adapter so the model gets a reason instead of a Gmail error to work around.
export const UNMODIFIABLE_LABELS = ["SENT", "DRAFT"] as const;

// The system labels worth showing. A mailbox also carries CATEGORY_*, CHAT and
// friends; listing all of them would spend context on noise the user never
// names.
export const LISTED_SYSTEM_LABELS = [
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SPAM",
  "TRASH",
] as const;

// --- Calendar ---

// A calendar from the user's calendarList. Users have several (own, work,
// shared, subscribed); never assume `primary`.
export interface CalendarSummary {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

// Event start/end carry an IANA timezone, not a bare offset, so Google resolves
// DST for future dates. All-day events use `date` instead.
export type EventDateTime =
  | { dateTime: string; timeZone: string }
  | { date: string };

export interface CalendarEvent {
  id?: string;
  summary: string;
  description?: string;
  location?: string;
  start: EventDateTime;
  end: EventDateTime;
  attendees?: string[];
  // Which calendar this event lives on, tagged during the multi-calendar
  // fan-out so the model can say where an event is.
  calendarId?: string;
  calendarSummary?: string;
}

// Event to create. No id/calendar tags; the caller passes calendarId separately.
export type CreateEventInput = Omit<
  CalendarEvent,
  "id" | "calendarId" | "calendarSummary"
>;

// from/to are RFC-3339 timestamps (the tool resolves the user's wall-clock into
// these using their zone). With no calendarIds the adapter fans out over every
// calendar with at least reader access.
export interface ListEventsParams {
  from: string;
  to: string;
  query?: string;
  calendarIds?: string[];
}

export interface MailApi {
  search(query: string): Promise<MailThreadSummary[]>;
  getThread(threadId: string): Promise<MailThread>;
  downloadAttachment(messageId: string, partId: string): Promise<{
    filename: string;
    mimeType: string;
    declaredSize: number;
    bytes: Uint8Array;
  }>;
  send(input: SendMailInput): Promise<{ id: string }>;

  // --- labels ---
  listLabels(): Promise<MailLabel[]>;
  createLabel(name: string): Promise<MailLabel>;
  renameLabel(name: string, newName: string): Promise<MailLabel>;

  // --- thread state ---
  // Labels by name. Archive is remove INBOX, mark read is remove UNREAD, star
  // is add STARRED; there is no separate call for any of them.
  modifyThread(input: {
    threadId: string;
    add?: string[];
    remove?: string[];
  }): Promise<{ threadId: string; labels: string[] }>;
  trashThread(threadId: string): Promise<void>;
  untrashThread(threadId: string): Promise<void>;

  // --- drafts ---
  listDrafts(): Promise<MailDraftSummary[]>;
  // Create, or replace the message of an existing draft. Replace, never patch:
  // Gmail cannot edit a draft's message, only swap it, so a caller that omits a
  // field drops it.
  saveDraft(input: SendMailInput & { draftId?: string }): Promise<MailDraft>;
  // Irreversible. Deletes the draft and returns the id of the sent message.
  sendDraft(draftId: string): Promise<{ id: string }>;
}

export interface CalendarApi {
  listCalendars(): Promise<CalendarSummary[]>;
  listEvents(params: ListEventsParams): Promise<CalendarEvent[]>;
  createEvent(
    event: CreateEventInput,
    calendarId?: string,
  ): Promise<CalendarEvent>;
}

// --- Drive ---

// A Drive file as the model sees it. Unlike Gmail labels (spoken by name
// because a model cannot invent "Label_12"), Drive is addressed by ID: names
// are not unique, so "the invoice" is ambiguous in a way the model cannot see.
// Every id the model uses comes from a prior drive_search result.
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  // null for Google-native files (Docs/Sheets/Slides), which have no bytes.
  byteSize: number | null;
  modifiedAt: string;
  webViewLink: string | null;
  isFolder: boolean;
}

export interface DriveSearchParams {
  // Matched against both the file name and its full text.
  query?: string;
  mimeType?: string;
  folderId?: string;
  trashed?: boolean;
}

export interface DriveDownload {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface DriveUploadInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  folderId?: string;
}

export interface DriveApi {
  search(params: DriveSearchParams): Promise<DriveFile[]>;
  get(fileId: string): Promise<DriveFile>;
  // Bytes for the Zero file store: binary files as they are, Google-native
  // files exported (Docs/Slides as PDF, Sheets as CSV).
  download(fileId: string): Promise<DriveDownload>;
  upload(input: DriveUploadInput): Promise<DriveFile>;
  createFolder(input: { name: string; parentId?: string }): Promise<DriveFile>;
  // Reversible. Drive's permanent delete is deliberately not exposed.
  trash(fileId: string, restore?: boolean): Promise<DriveFile>;
}

export interface GoogleWorkspace {
  mail: MailApi;
  calendar: CalendarApi;
  drive: DriveApi;
}
