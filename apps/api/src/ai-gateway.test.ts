import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OutboundHandler } from "@cloudflare/containers";
import { withGatewayMetadata, type GatewayMetadataParams } from "./ai-gateway";
import { createSecretProxy } from "./secret-proxy";
import type { Env } from "./types";

// Fake inner handler: records the request it was handed and returns a marker
// response, so we can assert what the wrapper forwards.
const makeInner = () => {
  let seen: Request | null = null;
  const handler: OutboundHandler<Env, GatewayMetadataParams> = (req) => {
    seen = req;
    return new Response("inner");
  };
  return { handler, seen: () => seen };
};

const env = {} as unknown as Env;

const ctx = (userId?: string) =>
  ({
    containerId: "c1",
    className: "AgentContainer",
    params: userId ? { userId } : undefined,
  }) as never;

const gatewayReq = (headers: Record<string, string> = {}) =>
  new Request("https://gateway.ai.cloudflare.com/v1/acct/zero/anthropic/v1/messages", {
    method: "POST",
    headers,
    body: "{}",
  });

describe("withGatewayMetadata", () => {
  it("tags gateway requests with the authenticated user_id", async () => {
    const inner = makeInner();
    const wrapped = withGatewayMetadata(inner.handler);

    await wrapped(gatewayReq(), env, ctx("user-123"));

    expect(inner.seen()?.headers.get("cf-aig-metadata")).toBe(
      JSON.stringify({ user_id: "user-123" }),
    );
  });

  it("does not tag non-gateway hosts even when userId is present", async () => {
    const inner = makeInner();
    const wrapped = withGatewayMetadata(inner.handler);
    const req = new Request("https://api.github.com/user", { method: "POST", body: "{}" });

    await wrapped(req, env, ctx("user-123"));

    expect(inner.seen()?.headers.get("cf-aig-metadata")).toBeNull();
  });

  it("does not tag gateway requests when no userId is supplied", async () => {
    const inner = makeInner();
    const wrapped = withGatewayMetadata(inner.handler);

    await wrapped(gatewayReq(), env, ctx());

    expect(inner.seen()?.headers.get("cf-aig-metadata")).toBeNull();
  });

  it("overwrites a container-supplied cf-aig-metadata (authoritative)", async () => {
    const inner = makeInner();
    const wrapped = withGatewayMetadata(inner.handler);
    const req = gatewayReq({ "cf-aig-metadata": JSON.stringify({ user_id: "spoofed" }) });

    await wrapped(req, env, ctx("user-123"));

    expect(inner.seen()?.headers.get("cf-aig-metadata")).toBe(
      JSON.stringify({ user_id: "user-123" }),
    );
  });

  it("forwards the inner handler's response", async () => {
    const inner = makeInner();
    const wrapped = withGatewayMetadata(inner.handler);

    const res = await wrapped(gatewayReq(), env, ctx("user-123"));

    expect(await res.text()).toBe("inner");
  });
});

// Composed path: the real registration is `withGatewayMetadata(secretProxy.outbound)`.
// Assert one gateway request gets BOTH the substituted secret and the user tag.
describe("withGatewayMetadata + secret-proxy (composed)", () => {
  let captured: Headers | null = null;

  beforeEach(() => {
    captured = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        captured = init.headers as Headers;
        return Promise.resolve(new Response("ok"));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("substitutes the secret and tags the user on the same request", async () => {
    const proxy = createSecretProxy(["CLOUDFLARE_API_KEY"]);
    const wrapped = withGatewayMetadata(proxy.outbound);
    const env = { CLOUDFLARE_API_KEY: "real-cloudflare-token" } as unknown as Env;
    const req = gatewayReq({
      "cf-aig-authorization": "Bearer Z3R0-FAKE-CLOUDFLARE_API_KEY",
    });

    await wrapped(req, env, ctx("user-123"));

    expect(captured?.get("cf-aig-authorization")).toBe("Bearer real-cloudflare-token");
    expect(captured?.get("cf-aig-metadata")).toBe(JSON.stringify({ user_id: "user-123" }));
  });
});
