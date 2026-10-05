import { createDashboardApp } from "./dashboard-app";
import type { Env } from "./types";

const DASH_HOST = "dash.zeroapps.dev";
const API_HOST = "api.zeroapps.dev";

function notFound() {
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const app = createDashboardApp(env);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const isDashboardRequest = isLocal || url.hostname === DASH_HOST;

    if (url.hostname === API_HOST) {
      if (
        url.pathname === "/ping" ||
        url.pathname.startsWith("/vault/v1/") ||
        url.pathname.startsWith("/errors/v1/")
      ) {
        return app.fetch(request, env, ctx);
      }
      return notFound();
    }

    if (isDashboardRequest && (url.pathname === "/ping" || url.pathname.startsWith("/api/"))) {
      return app.fetch(request, env, ctx);
    }

    return notFound();
  },
};
