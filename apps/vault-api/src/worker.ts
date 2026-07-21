/**
 * ============================================================================
 * Cloudflare Worker Entry Point
 * ============================================================================
 */

import type { Env } from "./types";
import { createApp } from "./app";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return createApp(env).fetch(req, env, ctx);
  },
};
