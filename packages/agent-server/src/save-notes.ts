import { existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";

import { log, logError, fmtErr } from "./log.js";

export const saveNotes = async (
  notesDir: string,
  callbackUrl: string,
  clerkUserId: string,
): Promise<void> => {
  if (!existsSync(notesDir)) return;

  const entries = readdirSync(notesDir);
  if (entries.length === 0) return;

  let archive: Buffer;
  try {
    archive = execSync(`tar cz -C ${notesDir} .`, { maxBuffer: 50 * 1024 * 1024 });
  } catch (err) {
    logError("save_notes_tar_failed", { error: fmtErr(err) });
    return;
  }

  const url = `${callbackUrl}/notes`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "X-Clerk-User-Id": clerkUserId,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    if (!res.ok) {
      logError("save_notes_upload_failed", { status: res.status });
      return;
    }
    log("save_notes_ok", { size: archive.length });
  } catch (err) {
    logError("save_notes_upload_threw", { error: fmtErr(err) });
  }
};
