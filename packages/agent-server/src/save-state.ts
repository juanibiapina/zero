import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { log, logError, fmtErr } from "./log.js";

// Archive the entire /workspace tree (sessions + notes + pi's working
// files) and PUT it to the worker, which stores it at
// <clerkUserId>/state.tar.gz in R2. One save function for all mutable data.
export const saveState = async (
  workspaceDir: string,
  callbackUrl: string,
  clerkUserId: string,
): Promise<void> => {
  if (!existsSync(workspaceDir)) return;

  const entries = readdirSync(workspaceDir);
  if (entries.length === 0) return;

  let archive: Buffer;
  try {
    archive = execFileSync("tar", ["cz", "-C", workspaceDir, "."], { maxBuffer: 100 * 1024 * 1024 });
  } catch (err) {
    logError("save_state_tar_failed", { error: fmtErr(err) });
    return;
  }

  const url = `${callbackUrl}/state`;
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
      logError("save_state_upload_failed", { status: res.status });
      return;
    }
    log("save_state_ok", { size: archive.length });
  } catch (err) {
    logError("save_state_upload_threw", { error: fmtErr(err) });
  }
};
