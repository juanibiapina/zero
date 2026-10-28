import type { SetTitleResult } from "@zero/agent-core";

import { isDurableObjectReset } from "../do/retry";
import { fmtErr, log, logError } from "../log";
import { normalizeTitle, type Titler } from "../transcription/titler";

// Server bookkeeping for one untitled Recording. It lives in Durable Object
// storage, outside the synchronized workspace.
export type TitleAttempt = { attempts: number; nextAt: number; reported: boolean };

export type TitleAttempts = {
  list(): Promise<Map<string, TitleAttempt>>;
  put(id: string, attempt: TitleAttempt): Promise<void>;
  delete(id: string): Promise<void>;
};

export type UntitledRecordings = {
  untitled(): Array<{ id: string; transcript: { text: string } | null }>;
  setTitle(id: string, title: string): Promise<SetTitleResult>;
};

export type ReportTitleFailure = (error: unknown, context: { site: "recording_title"; recording_id: string }) => Promise<void>;

const MINUTE = 60_000;
// Waits after the 1st to 4th failed attempt. From the 5th on, retry daily.
const BACKOFF = [MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE];
const DAY = 24 * 60 * MINUTE;
export const REPORT_AFTER = 5;

export function createTitleQueue({ recordings, titler, attempts, report, isErased, clock = Date.now }: {
  recordings: UntitledRecordings;
  titler: Titler;
  attempts: TitleAttempts;
  report: ReportTitleFailure;
  isErased: () => Promise<boolean>;
  clock?: () => number;
}) {
  // Titles every untitled Recording that is due, one at a time, and returns
  // when the next one is due, or null when none is waiting.
  async function runDue(): Promise<number | null> {
    const now = clock();
    const pending = recordings.untitled();
    const states = await attempts.list();
    const waiting = new Set(pending.map(({ id }) => id));
    for (const id of states.keys()) if (!waiting.has(id)) await attempts.delete(id);

    let next: number | null = null;
    const later = (at: number) => { next = next === null ? at : Math.min(next, at); };
    for (const { id } of pending) {
      const state = states.get(id) ?? { attempts: 0, nextAt: now, reported: false };
      if (state.nextAt > now) {
        later(state.nextAt);
        continue;
      }
      // An earlier request may have spanned an erasure, a deletion or a
      // title from elsewhere; only a current untitled note goes to the Titler.
      if (await isErased()) return null;
      const current = recordings.untitled().find((recording) => recording.id === id);
      if (!current) {
        await attempts.delete(id);
        continue;
      }
      const started = clock();
      try {
        const title = normalizeTitle(await titler.title(current.transcript?.text ?? ""));
        if (title === "") throw new Error("Titler returned an empty title");
        await recordings.setTitle(id, title);
        await attempts.delete(id);
        log("recording_titled", { recording_id: id, model: titler.model, latency_ms: clock() - started });
      } catch (error) {
        // A deploy reset interrupts the attempt; the next alarm resumes it.
        if (isDurableObjectReset(error)) throw error;
        const count = state.attempts + 1;
        const giveUp = count >= REPORT_AFTER;
        if (giveUp && !state.reported) await report(error, { site: "recording_title", recording_id: id });
        const nextAt = clock() + (BACKOFF[count - 1] ?? DAY);
        await attempts.put(id, { attempts: count, nextAt, reported: state.reported || giveUp });
        logError("recording_title_failed", { recording_id: id, attempt: count, error: fmtErr(error) });
        later(nextAt);
      }
    }
    // A transcript stored while this run awaited the Titler set an alarm for
    // now; the caller's setAlarm(next) would overwrite it with a backoff time.
    if (recordings.untitled().some(({ id }) => !waiting.has(id))) later(clock());
    return next;
  }

  return { runDue };
}
