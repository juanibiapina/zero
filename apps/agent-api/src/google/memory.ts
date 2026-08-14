// In-memory GoogleWorkspace adapter for tests. Returns canned threads/events and
// records sent mail and created events for assertions, mirroring
// createMemorySearch. Deterministic: reads ignore the query/window unless a
// filter is given, so agent loops are reproducible.

import type {
  CalendarEvent,
  CalendarSummary,
  CreateEventInput,
  DriveDownload,
  DriveFile,
  DriveSearchParams,
  DriveUploadInput,
  GoogleWorkspace,
  ListEventsParams,
  MailDraft,
  MailDraftSummary,
  MailLabel,
  MailHistory,
  MailThread,
  MailThreadSummary,
  MailWatermark,
  SendMailInput,
} from "./types";
import {
  GoogleNotConnectedError,
  LISTED_SYSTEM_LABELS,
  UNMODIFIABLE_LABELS,
} from "./types";

export interface MemoryGoogleSeed {
  threadSummaries?: MailThreadSummary[];
  threads?: Record<string, MailThread>;
  attachments?: Record<string, {
    filename: string;
    mimeType: string;
    declaredSize?: number;
    bytes: Uint8Array;
  }>;
  // User labels that already exist. The listed system labels are always there.
  labels?: string[];
  // Labels currently on a thread, by threadId.
  threadLabels?: Record<string, string[]>;
  drafts?: MailDraftSummary[];
  calendars?: CalendarSummary[];
  events?: CalendarEvent[];
  // Drive files the user already has, by id.
  driveFiles?: DriveFile[];
  // Bytes download returns, by file id.
  driveBytes?: Record<string, Uint8Array>;
  // The mailbox history watermark getWatermark reports and listChangedThreads
  // returns as its new watermark.
  historyId?: string;
  // Threads listChangedThreads reports as having new inbox mail.
  changedThreadIds?: string[];
  // When true, listChangedThreads reports the watermark as expired (Gmail 404).
  historyExpired?: boolean;
  // When true, every method throws GoogleNotConnectedError (simulates a user
  // who hasn't connected Google).
  notConnected?: boolean;
}

export interface MemoryGoogle extends GoogleWorkspace {
  sentMail: SendMailInput[];
  createdEvents: { event: CreateEventInput; calendarId: string }[];
  // Every accepted label change, in order, so a test can assert what a turn did
  // to the mailbox the same way sentMail asserts what it sent.
  modifications: { threadId: string; add: string[]; remove: string[] }[];
  trashed: { threadId: string; restore: boolean }[];
  savedDrafts: (SendMailInput & { draftId: string })[];
  sentDrafts: string[];
  // Watermarks listChangedThreads was called with, in order.
  historyCalls: string[];
  uploadedFiles: DriveUploadInput[];
  createdFolders: { name: string; parentId?: string }[];
  trashedFiles: { fileId: string; restore: boolean }[];
}

export const createMemoryGoogle = (
  seed: MemoryGoogleSeed = {},
): MemoryGoogle => {
  const sentMail: SendMailInput[] = [];
  const createdEvents: { event: CreateEventInput; calendarId: string }[] = [];
  const modifications: { threadId: string; add: string[]; remove: string[] }[] = [];
  const trashed: { threadId: string; restore: boolean }[] = [];
  const savedDrafts: (SendMailInput & { draftId: string })[] = [];
  const sentDrafts: string[] = [];
  const historyCalls: string[] = [];
  // Thread a draft replies into, so sending it reports the same thread.
  const draftThreads = new Map<string, string>();
  const watermark = seed.historyId ?? "1000";
  const uploadedFiles: DriveUploadInput[] = [];
  const createdFolders: { name: string; parentId?: string }[] = [];
  const trashedFiles: { fileId: string; restore: boolean }[] = [];
  const driveFiles = new Map<string, DriveFile>(
    (seed.driveFiles ?? []).map((f) => [f.id, f]),
  );
  const userLabels = new Set(seed.labels ?? []);
  const threadLabels = new Map<string, string[]>(
    Object.entries(seed.threadLabels ?? {}),
  );
  const drafts = new Map<string, MailDraftSummary>(
    (seed.drafts ?? []).map((d) => [d.draftId, d]),
  );

  const guard = () => {
    if (seed.notConnected) throw new GoogleNotConnectedError();
  };

  // Same rules the REST adapter enforces, so a test over the memory adapter
  // fails where production would.
  const resolve = (name: string): string => {
    if ((UNMODIFIABLE_LABELS as readonly string[]).includes(name.toUpperCase()))
      throw new Error(`Gmail does not allow changing the ${name.toUpperCase()} label.`);
    if ((LISTED_SYSTEM_LABELS as readonly string[]).includes(name.toUpperCase()))
      return name.toUpperCase();
    const match = [...userLabels].find(
      (l) => l.toLowerCase() === name.toLowerCase(),
    );
    if (!match)
      throw new Error(
        `No Gmail label named "${name}". Existing labels: ${[...userLabels].join(", ")}.`,
      );
    return match;
  };

  return {
    sentMail,
    createdEvents,
    modifications,
    trashed,
    savedDrafts,
    sentDrafts,
    historyCalls,
    uploadedFiles,
    createdFolders,
    trashedFiles,
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
      async send(input: SendMailInput): Promise<{ id: string; threadId: string }> {
        guard();
        sentMail.push(input);
        return {
          id: `sent-${sentMail.length}`,
          // A reply stays in the thread it answers; a fresh mail starts one.
          threadId: input.replyTo?.threadId ?? `thread-sent-${sentMail.length}`,
        };
      },

      async getWatermark(): Promise<MailWatermark> {
        guard();
        return { historyId: watermark };
      },

      async listChangedThreads(startHistoryId: string): Promise<MailHistory> {
        guard();
        if (seed.historyExpired) return { ok: false, reason: "expired" };
        historyCalls.push(startHistoryId);
        return {
          ok: true,
          historyId: watermark,
          threadIds: [...(seed.changedThreadIds ?? [])],
        };
      },

      async listLabels(): Promise<MailLabel[]> {
        guard();
        const system: MailLabel[] = LISTED_SYSTEM_LABELS.map((name) => ({
          name,
          type: "system",
        }));
        const user: MailLabel[] = [...userLabels].map((name) => ({
          name,
          type: "user",
        }));
        return [...system, ...user];
      },

      async createLabel(name: string): Promise<MailLabel> {
        guard();
        if (userLabels.has(name)) throw new Error(`A Gmail label named "${name}" already exists.`);
        userLabels.add(name);
        return { name, type: "user" };
      },

      async renameLabel(name: string, newName: string): Promise<MailLabel> {
        guard();
        const existing = resolve(name);
        userLabels.delete(existing);
        userLabels.add(newName);
        return { name: newName, type: "user" };
      },

      async modifyThread({ threadId, add, remove }) {
        guard();
        const added = (add ?? []).map(resolve);
        const removed = (remove ?? []).map(resolve);
        modifications.push({ threadId, add: added, remove: removed });
        const current = new Set(threadLabels.get(threadId) ?? []);
        for (const label of added) current.add(label);
        for (const label of removed) current.delete(label);
        const labels = [...current];
        threadLabels.set(threadId, labels);
        return { threadId, labels };
      },

      async trashThread(threadId: string): Promise<void> {
        guard();
        trashed.push({ threadId, restore: false });
      },

      async untrashThread(threadId: string): Promise<void> {
        guard();
        trashed.push({ threadId, restore: true });
      },

      async listDrafts(): Promise<MailDraftSummary[]> {
        guard();
        return [...drafts.values()];
      },

      async saveDraft(input): Promise<MailDraft> {
        guard();
        const draftId = input.draftId ?? `draft-${drafts.size + 1}`;
        savedDrafts.push({ ...input, draftId });
        if (input.replyTo) draftThreads.set(draftId, input.replyTo.threadId);
        drafts.set(draftId, {
          draftId,
          to: input.to,
          subject: input.subject,
          snippet: input.body.slice(0, 80),
        });
        return { draftId, threadId: input.replyTo?.threadId ?? null };
      },

      async sendDraft(draftId: string): Promise<{ id: string; threadId: string }> {
        guard();
        if (!drafts.has(draftId)) throw new Error(`No draft with id ${draftId}.`);
        drafts.delete(draftId);
        sentDrafts.push(draftId);
        return {
          id: `sent-draft-${sentDrafts.length}`,
          threadId:
            draftThreads.get(draftId) ?? `thread-draft-${sentDrafts.length}`,
        };
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
    drive: {
      async search(params: DriveSearchParams): Promise<DriveFile[]> {
        guard();
        const all = [...driveFiles.values()];
        if (!params.mimeType) return all;
        return all.filter((f) => f.mimeType === params.mimeType);
      },
      async get(fileId: string): Promise<DriveFile> {
        guard();
        const file = driveFiles.get(fileId);
        if (!file) throw new Error(`No Drive file with id ${fileId}.`);
        return file;
      },
      async download(fileId: string): Promise<DriveDownload> {
        guard();
        const file = driveFiles.get(fileId);
        if (!file) throw new Error(`No Drive file with id ${fileId}.`);
        const bytes = seed.driveBytes?.[fileId];
        if (!bytes) throw new Error(`"${file.name}" has no downloadable content.`);
        return {
          filename: file.name,
          mimeType: file.mimeType,
          bytes: bytes.slice(),
        };
      },
      async upload(input: DriveUploadInput): Promise<DriveFile> {
        guard();
        uploadedFiles.push(input);
        const file: DriveFile = {
          id: `drive-${uploadedFiles.length}`,
          name: input.filename,
          mimeType: input.mimeType,
          byteSize: input.bytes.length,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          webViewLink: null,
          isFolder: false,
        };
        driveFiles.set(file.id, file);
        return file;
      },
      async createFolder({ name, parentId }): Promise<DriveFile> {
        guard();
        createdFolders.push({ name, parentId });
        const folder: DriveFile = {
          id: `folder-${createdFolders.length}`,
          name,
          mimeType: "application/vnd.google-apps.folder",
          byteSize: null,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          webViewLink: null,
          isFolder: true,
        };
        driveFiles.set(folder.id, folder);
        return folder;
      },
      async trash(fileId: string, restore = false): Promise<DriveFile> {
        guard();
        const file = driveFiles.get(fileId);
        if (!file) throw new Error(`No Drive file with id ${fileId}.`);
        trashedFiles.push({ fileId, restore });
        return file;
      },
    },
  };
};
