import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSecretProxy } from "./secret-proxy";
import type { Env } from "./types";

// Capture the request the handler forwards via global `fetch`.
interface Captured {
  url: string;
  headers: Headers;
}

let captured: Captured | null;

beforeEach(() => {
  captured = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      captured = { url, headers: init.headers as Headers };
      return Promise.resolve(new Response("ok"));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx = (overrides?: Record<string, string>) =>
  ({
    containerId: "c1",
    className: "AgentContainer",
    params: overrides ? { overrides } : undefined,
  }) as never;

const b64 = (s: string): string => btoa(s);
const decodeBasic = (header: string): string => atob(header.replace(/^Basic /, ""));

describe("secret proxy — verbatim substitution", () => {
  it("substitutes a sentinel that appears raw in a header value", async () => {
    const proxy = createSecretProxy(["CLOUDFLARE_API_KEY"]);
    const env = { CLOUDFLARE_API_KEY: "real-cloudflare-token" } as unknown as Env;
    const req = new Request("https://gateway.ai.cloudflare.com/v1/acct/zero/anthropic/v1/messages", {
      method: "POST",
      headers: { "cf-aig-authorization": "Bearer Z3R0-FAKE-CLOUDFLARE_API_KEY" },
      body: "{}",
    });

    await proxy.outbound(req, env, ctx());

    expect(captured?.headers.get("cf-aig-authorization")).toBe("Bearer real-cloudflare-token");
  });
});

describe("secret proxy — Basic auth substitution", () => {
  it("substitutes a sentinel inside a Basic auth header (token as password)", async () => {
    const proxy = createSecretProxy([], ["GH_TOKEN"]);
    const env = {} as unknown as Env;
    const req = new Request(
      "https://github.com/octocat/Hello-World.git/git-receive-pack",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${b64("x-access-token:Z3R0-FAKE-GH_TOKEN")}`,
        },
        body: "pack",
      },
    );

    await proxy.outbound(req, env, ctx({ GH_TOKEN: "ghp_realtoken" }));

    const auth = captured?.headers.get("Authorization") ?? "";
    expect(decodeBasic(auth)).toBe("x-access-token:ghp_realtoken");
  });

  it("substitutes a sentinel inside a Basic auth header (token as username)", async () => {
    const proxy = createSecretProxy([], ["GH_TOKEN"]);
    const env = {} as unknown as Env;
    const req = new Request("https://github.com/octocat/Hello-World.git/git-receive-pack", {
      method: "POST",
      headers: { Authorization: `Basic ${b64("Z3R0-FAKE-GH_TOKEN:x-oauth-basic")}` },
      body: "pack",
    });

    await proxy.outbound(req, env, ctx({ GH_TOKEN: "ghp_realtoken" }));

    const auth = captured?.headers.get("Authorization") ?? "";
    expect(decodeBasic(auth)).toBe("ghp_realtoken:x-oauth-basic");
  });

  it("leaves a Basic auth header without any sentinel untouched", async () => {
    const proxy = createSecretProxy([], ["GH_TOKEN"]);
    const env = {} as unknown as Env;
    const original = `Basic ${b64("alice:hunter2")}`;
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { Authorization: original },
      body: "x",
    });

    await proxy.outbound(req, env, ctx({ GH_TOKEN: "ghp_realtoken" }));

    expect(captured?.headers.get("Authorization")).toBe(original);
  });

  it("leaves a malformed (non-base64) Basic value untouched without throwing", async () => {
    const proxy = createSecretProxy([], ["GH_TOKEN"]);
    const env = {} as unknown as Env;
    const original = "Basic !!!not-base64!!!";
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { Authorization: original },
      body: "x",
    });

    await proxy.outbound(req, env, ctx({ GH_TOKEN: "ghp_realtoken" }));

    expect(captured?.headers.get("Authorization")).toBe(original);
  });
});
