/**
 * Creating a named pipe.
 *
 * Node has no binding for mkfifo(3) and the CLI ships no native dependency, so
 * this shells out to the POSIX `mkfifo` utility. Windows has no equivalent, so
 * the mount transport is unavailable there and says so.
 */

import { execFileSync } from "node:child_process";

export function mkfifoSync(path: string, mode = 0o600): void {
  if (process.platform === "win32") {
    throw new Error(
      "--mount needs a named pipe, which this platform does not provide. " +
        "Run without --mount to pass the secrets as environment variables.",
    );
  }

  try {
    execFileSync("mkfifo", ["-m", mode.toString(8).padStart(3, "0"), path], {
      stdio: "pipe",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not create the pipe at ${path}: ${detail}`, { cause: err });
  }
}
