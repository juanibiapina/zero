/**
 * Running a command with an environment's secrets, without a plaintext file.
 *
 * Two transports, because the tools that consume secrets read them in two
 * different ways:
 *
 *   - process environment (default): Vite and ordinary scripts. Values that
 *     already exist in the environment win over Vite's own .env files, so an
 *     injected value is all a build needs.
 *
 *   - ephemeral mount (`--mount`): wrangler. When a `.dev.vars` file exists,
 *     wrangler reads it and never looks at the process environment; when it
 *     does not, wrangler copies the whole host environment into the worker's
 *     bindings and silently drops any key missing from `secrets.required`. A
 *     named pipe at the `.dev.vars` path keeps wrangler on its normal, fully
 *     documented route, with no host leakage and no filtering surprise.
 *
 * The pipe is served one payload per reader open, in a loop, because a writer
 * that does not pair each write with a reader open produces concatenated,
 * corrupt reads.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkfifoSync } from "./mkfifo.js";
import { formatEnv, type Secret } from "./formats.js";

/**
 * Names that change how the child process itself runs. Injecting one turns a
 * secret store into a code execution path, so a hit is an error, never a
 * silent skip. Doppler documents the same list for `doppler run`.
 */
export const UNSAFE_ENV_NAMES = [
  "BROWSER",
  "DYLD_INSERT_LIBRARIES",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PERL5OPT",
  "PHPRC",
  "PROMPT_COMMAND",
  "PYTHONWARNINGS",
  "USERPROFILE",
  "WINDIR",
] as const;

export class RunError extends Error {}

export interface RunOptions {
  secrets: Secret[];
  command: string;
  args: string[];
  /** Path of the named pipe to serve. When set, nothing is injected. */
  mount?: string;
  mountFormat?: "env" | "json";
}

/** Exit code of the child, using the shell's 128+signal convention. */
export async function runWithSecrets(options: RunOptions): Promise<number> {
  const { secrets, command, args, mount } = options;

  if (mount) {
    return runWithMount(options, mount);
  }

  const unsafe = secrets
    .map((s) => s.key)
    .filter((key) => (UNSAFE_ENV_NAMES as readonly string[]).includes(key));
  if (unsafe.length > 0) {
    throw new RunError(
      `refusing to inject ${unsafe.join(", ")}: ${unsafe.length > 1 ? "these names change" : "this name changes"} how the command runs. ` +
        "Rename the secret, or use --mount to pass it as a file.",
    );
  }

  const env = { ...process.env };
  for (const { key, value } of secrets) env[key] = value;

  return spawnChild(command, args, env);
}

async function runWithMount(options: RunOptions, mount: string): Promise<number> {
  const { secrets, command, args, mountFormat = "env" } = options;

  if (fs.existsSync(mount)) {
    throw new RunError(
      `${mount} already exists. Remove it first: run refuses to replace a path it did not create.`,
    );
  }

  const payload =
    mountFormat === "json"
      ? JSON.stringify(
          Object.fromEntries(secrets.map((s) => [s.key, s.value])),
          null,
          2,
        ) + "\n"
      : formatEnv(secrets) + "\n";

  mkfifoSync(mount, 0o600);

  let serving = true;
  const serve = async (): Promise<void> => {
    while (serving) {
      try {
        await new Promise<void>((resolve, reject) => {
          // Opening a FIFO for writing blocks until a reader opens it, so this
          // loop costs nothing while the child is not reading.
          const stream = fs.createWriteStream(mount);
          stream.on("open", () => stream.end(payload));
          stream.on("close", () => resolve());
          stream.on("error", (err) => reject(err));
        });
      } catch {
        // The pipe is gone (cleanup) or the reader vanished mid-write. Either
        // way there is nothing to recover: stop serving.
        return;
      }
    }
  };
  void serve();

  const cleanup = () => {
    if (!serving) return;
    serving = false;
    // A pending open() for writing blocks forever if nothing ever reads, which
    // would outlive the child. Opening the read end releases it.
    try {
      fs.closeSync(fs.openSync(mount, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK));
    } catch {
      // Already gone.
    }
    try {
      fs.unlinkSync(mount);
    } catch {
      // Already gone.
    }
  };

  try {
    return await spawnChild(command, args, { ...process.env });
  } finally {
    cleanup();
  }
}

function spawnChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env, shell: false });

    // Ctrl+C reaches this process first when it runs under turbo or a shell.
    // The child owns the terminal, so it must get the signal too, and this
    // process must wait for it to exit rather than dying first.
    const forward = (signal: NodeJS.Signals) => () => {
      if (!child.killed) child.kill(signal);
    };
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);

    const done = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      done();
      reject(
        err.code === "ENOENT"
          ? new RunError(`command not found: ${command}`)
          : err,
      );
    });

    child.on("exit", (code, signal) => {
      done();
      resolve(signal ? 128 + signalNumber(signal) : (code ?? 0));
    });
  });
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

function signalNumber(signal: NodeJS.Signals): number {
  return SIGNAL_NUMBERS[signal] ?? 0;
}
