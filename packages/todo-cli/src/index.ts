import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { run } from "./cli";

const openBrowser = async (url: string) => {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
};

const confirm = async (question: string) => {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
};

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  openBrowser,
  confirm: process.stdin.isTTY ? confirm : null,
});
