/**
 * The payoff, through the real binary: a workflow with no key and no config
 * file authenticates by exchanging its GitHub OIDC token.
 *
 * The stub server plays both the runner's token endpoint and the Zero API, so
 * nothing here touches GitHub.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const execFileAsync = promisify(execFile);

let server: http.Server;
let baseUrl: string;
let requests: { method: string; url: string; auth?: string; body?: string }[] = [];
let exchangeStatus = 200;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({
        method: req.method!,
        url: req.url!,
        auth: req.headers.authorization,
        body,
      });

      const url = req.url ?? "";

      // The runner's OIDC endpoint.
      if (url.startsWith("/idtoken")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ value: "github.oidc.jwt" }));
        return;
      }

      if (url === "/vault/v1/ci/token") {
        if (exchangeStatus !== 200) {
          res.writeHead(exchangeStatus, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Repository acme/app is not trusted",
              ownerId: "42",
              repoId: "777",
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accessToken: "zci_minted", expiresIn: 900, orgId: "org_ci" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          url.startsWith("/vault/v1/projects")
            ? { projects: [] }
            : { userId: "ci:github:777", orgId: "org_ci" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  exchangeStatus = 200;
});

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const clean = { ...process.env };
  delete clean.ZERO_API_KEY;
  return execFileAsync(tsx, [entry, "--base-url", baseUrl, ...args], {
    encoding: "utf8",
    env: {
      ...clean,
      ZERO_CONFIG: "/nonexistent/zero.json",
      ACTIONS_ID_TOKEN_REQUEST_URL: `${baseUrl}/idtoken?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-bearer",
      ...extraEnv,
    },
  });
}

describe("running inside GitHub Actions", () => {
  it("authenticates with no key anywhere", async () => {
    await run(["vault", "projects", "list"]);

    const exchange = requests.find((r) => r.url === "/vault/v1/ci/token");
    expect(exchange).toBeDefined();
    expect(JSON.parse(exchange!.body!)).toEqual({ token: "github.oidc.jwt" });

    const vaultCall = requests.find((r) => r.url.startsWith("/vault/v1/projects"));
    expect(vaultCall?.auth).toBe("Bearer zci_minted");
  });

  it("requests the OIDC token for the Zero audience", async () => {
    await run(["vault", "projects", "list"]);

    const idToken = requests.find((r) => r.url.startsWith("/idtoken"));
    expect(new URL(`http://x${idToken!.url}`).searchParams.get("audience")).toBe(
      "https://api.zeroapps.dev",
    );
    expect(idToken?.auth).toBe("Bearer runner-bearer");
  });

  it("reports the credential in whoami", async () => {
    const { stdout } = await run(["whoami"]);

    expect(stdout).toContain("Credential: github actions");
  });

  it("lets an explicit key win, so a repository can pin one during a migration", async () => {
    await run(["vault", "projects", "list"], { ZERO_API_KEY: "zv_pinned" });

    expect(requests.find((r) => r.url === "/vault/v1/ci/token")).toBeUndefined();
    expect(requests[0]?.auth).toBe("Bearer zv_pinned");
  });

  it("names the org when ZERO_ORG is set, for a repo two orgs trust", async () => {
    await run(["vault", "projects", "list"], { ZERO_ORG: "org_chosen" });

    const exchange = requests.find((r) => r.url === "/vault/v1/ci/token");
    expect(JSON.parse(exchange!.body!)).toEqual({
      token: "github.oidc.jwt",
      orgId: "org_chosen",
    });
  });

  it("fails with the server's reason and the ids to trust, rather than falling back", async () => {
    exchangeStatus = 403;

    await expect(run(["vault", "projects", "list"])).rejects.toThrow(
      /not trusted[\s\S]*--owner-id 42 --repo-id 777/,
    );
  });
});

describe("running outside GitHub Actions", () => {
  it("does not attempt an exchange when the job lacks id-token: write", async () => {
    const clean = { ...process.env };
    delete clean.ZERO_API_KEY;

    await expect(
      execFileAsync(tsx, [entry, "--base-url", baseUrl, "vault", "projects", "list"], {
        encoding: "utf8",
        env: {
          ...clean,
          ZERO_CONFIG: "/nonexistent/zero.json",
          // Set on every Actions run, but without the id-token permission the
          // request variables are absent — and that is the case that must not
          // look like CI auth.
          GITHUB_ACTIONS: "true",
        },
      }),
    ).rejects.toThrow(/no credentials/);

    expect(requests.find((r) => r.url === "/vault/v1/ci/token")).toBeUndefined();
  });
});
