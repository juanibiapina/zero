/**
 * `zero vault run` against a stub API, driving the real binary.
 *
 * These tests own the promises the command makes to every script in a repo:
 * the child sees the secrets, nothing lands on disk, the exit code is the
 * child's, and a name that could hijack the child is refused.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));

let server: http.Server;
let baseUrl: string;
let workDir: string;

/** The secrets the stub serves, keyed by environment. */
const environments: Record<string, { key: string; value: string }[]> = {
  production: [
    { key: "API_TOKEN", value: "t0ken" },
    { key: "GITHUB_APP_PRIVATE_KEY", value: "-----BEGIN\nline2\n-----END" },
  ],
  hostile: [{ key: "NODE_OPTIONS", value: "--require /tmp/evil.js" }],
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const env = /environments\/([^/]+)\/secrets/.exec(req.url ?? "")?.[1] ?? "";
    const secrets = environments[env];
    if (!secrets) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "environment not found" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ secrets }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-run-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(workDir, { recursive: true, force: true });
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Never rejects: the exit code is the thing under test. */
function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      tsx,
      [entry, "--base-url", baseUrl, ...args],
      {
        cwd: workDir,
        encoding: "utf8",
        env: {
          ...process.env,
          ZERO_CONFIG: "/nonexistent/zero.json",
          ZERO_API_KEY: "zv_test_key",
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const printEnv = (name: string) => [
  "node",
  "-e",
  `process.stdout.write(String(process.env.${name}))`,
];

describe("zero vault run", () => {
  it("gives the child the environment's secrets", async () => {
    const { stdout, code } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--",
      ...printEnv("API_TOKEN"),
    ]);

    expect(code).toBe(0);
    expect(stdout).toBe("t0ken");
  });

  it("prefers the secret over an inherited variable of the same name", async () => {
    const { stdout } = await run(
      ["vault", "run", "-p", "demo", "-e", "production", "--", ...printEnv("API_TOKEN")],
      { API_TOKEN: "from-host" },
    );

    expect(stdout).toBe("t0ken");
  });

  it("writes nothing of its own to stdout", async () => {
    const { stdout } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--",
      "node",
      "-e",
      "process.stdout.write('only-this')",
    ]);

    expect(stdout).toBe("only-this");
  });

  it("passes flags after -- to the child instead of parsing them", async () => {
    const { stdout } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--",
      "node",
      "-e",
      "process.stdout.write(process.argv.slice(1).join(','))",
      // node's own `--` so that it does not read --port as a node option
      "--",
      "--port",
      "8790",
      "-p",
      "other",
    ]);

    expect(stdout).toBe("--port,8790,-p,other");
  });

  it("exits with the child's exit code", async () => {
    const { code } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--",
      "node",
      "-e",
      "process.exit(3)",
    ]);

    expect(code).toBe(3);
  });

  it("refuses to inject a name that changes how the child runs", async () => {
    const { code, stderr } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "hostile",
      "--",
      "node",
      "-e",
      "process.stdout.write('ran')",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("NODE_OPTIONS");
  });

  it("fails when the environment does not exist", async () => {
    const { code } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "missing",
      "--",
      "node",
      "-e",
      "process.stdout.write('ran')",
    ]);

    expect(code).toBe(1);
  });

  it("reports a command that does not exist", async () => {
    const { code, stderr } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--",
      "definitely-not-a-command",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("command not found");
  });
});

describe("zero vault run --mount", () => {
  const readMount = (file: string, times: number) => [
    "node",
    "-e",
    `const fs=require('fs');let out=[];for(let i=0;i<${times};i++)out.push(fs.readFileSync('${file}','utf8'));process.stdout.write(JSON.stringify(out))`,
  ];

  it("serves one clean payload per read, back to back", async () => {
    // Regression: reopening the write end while the reader was still draining
    // merged two payloads into one read. A tight loop is what exposed it.
    const { stdout, code } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--mount",
      "tight.vars",
      "--",
      ...readMount("tight.vars", 20),
    ]);

    expect(code).toBe(0);
    const reads = JSON.parse(stdout) as string[];
    expect(reads).toHaveLength(20);
    for (const read of reads) {
      expect(read.split("\n").filter(Boolean)).toHaveLength(2);
    }
  });

  it("serves the same payload on every read", async () => {
    const { stdout, code } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--mount",
      "repeat.vars",
      "--",
      ...readMount("repeat.vars", 3),
    ]);

    expect(code).toBe(0);
    const reads = JSON.parse(stdout) as string[];
    expect(reads).toHaveLength(3);
    expect(new Set(reads).size).toBe(1);
    expect(reads[0]).toContain("API_TOKEN=t0ken");
  });

  it("escapes a multiline value so a dotenv parser reads it back", async () => {
    const { stdout } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--mount",
      "multiline.vars",
      "--",
      ...readMount("multiline.vars", 1),
    ]);

    const [payload] = JSON.parse(stdout) as string[];
    expect(payload).toContain('GITHUB_APP_PRIVATE_KEY="-----BEGIN\\nline2\\n-----END"');
    expect(payload.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("keeps the secrets out of the child's environment", async () => {
    const { stdout } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--mount",
      "env-free.vars",
      "--",
      ...printEnv("API_TOKEN"),
    ]);

    expect(stdout).toBe("undefined");
  });

  it("removes the pipe when the child exits", async () => {
    const mount = path.join(workDir, "gone.vars");
    await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--mount",
      mount,
      "--",
      ...readMount(mount, 1),
    ]);

    expect(fs.existsSync(mount)).toBe(false);
  });

  it("does not hang when the child never reads the pipe", async () => {
    const mount = path.join(workDir, "unread.vars");
    const { code } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--mount",
      mount,
      "--",
      "node",
      "-e",
      "process.exit(7)",
    ]);

    expect(code).toBe(7);
    expect(fs.existsSync(mount)).toBe(false);
  });

  it("refuses to replace a path that already exists", async () => {
    const mount = path.join(workDir, "existing.vars");
    fs.writeFileSync(mount, "REAL=file\n");

    const { code, stderr } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--mount",
      mount,
      "--",
      "node",
      "-e",
      "process.stdout.write('ran')",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("already exists");
    expect(fs.readFileSync(mount, "utf8")).toBe("REAL=file\n");
  });

  it("mounts JSON when asked", async () => {
    const mount = path.join(workDir, "secrets.json");
    const { stdout } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--mount",
      mount,
      "--mount-format",
      "json",
      "--",
      ...readMount(mount, 1),
    ]);

    const [payload] = JSON.parse(stdout) as string[];
    expect(JSON.parse(payload)).toMatchObject({ API_TOKEN: "t0ken" });
  });
});

describe("zero vault run --mount, wrong path", () => {
  it("says which directory is missing instead of reporting a raw mkfifo failure", async () => {
    const { code, stderr } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--mount",
      "no/such/dir/.dev.vars",
      "--",
      "node",
      "-e",
      "process.stdout.write('ran')",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("does not exist");
  });
});

describe("zero vault run --mount, cleanup", () => {
  it("never leaves a readable file behind, even when the child reads late", async () => {
    // Regression: the serving loop used a creating open, so once cleanup had
    // unlinked the pipe the next loop turn wrote the secrets into a plain file
    // at the same path and left it there.
    const mount = path.join(workDir, "late.vars");

    const { code } = await run([
      "vault",
      "run",
      "-p",
      "demo",
      "-e",
      "production",
      "--mount",
      mount,
      "--",
      "node",
      "-e",
      `const fs=require('fs');fs.readFileSync('${mount}','utf8');setTimeout(()=>process.exit(0),50)`,
    ]);

    expect(code).toBe(0);
    expect(fs.existsSync(mount)).toBe(false);
  });
});
