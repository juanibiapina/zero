// AI Gateway per-user attribution. Wraps an outbound handler so requests to
// Cloudflare AI Gateway carry the authenticated user as `cf-aig-metadata`,
// driving per-user analytics and split-by-value spend limits (referenced in
// the gateway as `metadata.user_id`). The tag is set worker-side — after the
// container boundary — so it is authoritative and the agent can't spoof it.
//
// This is kept separate from secret-proxy.ts: substitution knows nothing about
// Cloudflare or users; this knows nothing about secrets.

import type { OutboundHandler } from "@cloudflare/containers";
import type { Env } from "./types";

// Cloudflare AI Gateway egress host. pi-ai's cloudflare-ai-gateway provider
// sends LLM requests here; only these requests get tagged.
const AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";

export interface GatewayMetadataParams {
  /** Authenticated user id; tagged on AI Gateway requests for per-user
   *  analytics and split-by-value spend limits. */
  userId?: string;
}

/**
 * Wrap an outbound handler so AI Gateway requests carry `cf-aig-metadata`
 * with the authenticated `user_id`. Non-gateway egress, and requests with no
 * `userId`, are forwarded to `inner` untouched. `.set` overwrites any value
 * the container supplied, keeping the worker-set tag authoritative.
 */
export const withGatewayMetadata = <P>(
  inner: OutboundHandler<Env, P>,
): OutboundHandler<Env, P & GatewayMetadataParams> => {
  return (req, env, ctx) => {
    const userId = ctx.params?.userId;
    // ctx carries the widened params (P & userId); it is structurally a valid
    // context for `inner` (which only reads P), but the framework's conditional
    // context type blocks the assignment, so cast at this one boundary.
    const innerCtx = ctx as Parameters<typeof inner>[2];
    if (userId && hostOf(req.url) === AI_GATEWAY_HOST) {
      const headers = new Headers(req.headers);
      headers.set("cf-aig-metadata", JSON.stringify({ user_id: userId }));
      return inner(new Request(req, { headers }), env, innerCtx);
    }
    return inner(req, env, innerCtx);
  };
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};
