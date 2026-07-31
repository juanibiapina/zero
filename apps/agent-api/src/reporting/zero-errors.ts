// ZeroErrors reporting.
//
// Fire-and-forget exception reporting to ZeroErrors, dogfooding the suite's own
// error tracker. ZEROVAULT_API_KEY is a required secret (the deploy fails loud
// if it is unset), so reporting is always configured. The try/catch is runtime
// resilience against a ZeroErrors outage, not an opt-out: the returned promise
// never rejects, so it can be awaited in a Durable Object alarm or handed to
// `executionCtx.waitUntil` from an HTTP handler without ever disturbing the
// caller's error path.
//
// The suite uses a single `zv_` key (ZEROVAULT_API_KEY) for everything: the
// same org key that unlocks ZeroVault also authorizes ZeroErrors ingest, since
// both validate against the shared APIKEYS store. Ingest matches the
// /v1/errors contract in @zero/errors-core.

import { fmtErr, logError } from "../log";
import { isDurableObjectReset } from "../do/retry";

const ENDPOINT = "https://api.zeroapps.dev/errors/v1/errors";
const PROJECT = "zero-agent";

export type ReportLevel = "error" | "warning" | "info";

export interface ReportOptions {
  // Issue severity. ZeroErrors stamps the level when the issue is *created*,
  // so a later report with a different level does not change an existing
  // issue's severity.
  level?: ReportLevel;
}

export interface ReportEnv {
  ZEROVAULT_API_KEY: string;
  // Only "production" reports. Local dev and tests must never write into the
  // production issue list. `.dev.vars` sets "development"; the deployed Worker
  // gets "production" from its secret (declared in wrangler.jsonc's
  // secrets.required, so a deploy without it fails loud).
  ENVIRONMENT?: string;
}

export async function reportError(
  env: ReportEnv,
  err: unknown,
  context: Record<string, unknown> = {},
  options: ReportOptions = {},
): Promise<void> {
  // A Durable Object isolate reset is deploy noise, not a defect: every deploy
  // tears down in-flight DOs. Filtered here rather than at any single call
  // site, because a deploy resets turns, learning jobs and schedule RPCs alike
  // and each of those is a separate door into this function.
  if (isDurableObjectReset(err)) {
    logError("error_report_skipped", { reason: "durable_object_reset" });
    return;
  }
  if (env.ENVIRONMENT !== "production") {
    logError("error_report_skipped", { reason: "not_production" });
    return;
  }

  // fmtErr pulls out message/stack plus any AI-SDK/API detail (status code,
  // rate-limit headers, response body). Keep message/stack as the event's
  // top-level fields and fold the rest into context for the dashboard.
  const { message, stack, ...detail } = fmtErr(err);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ZEROVAULT_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        project: PROJECT,
        // Ingest rejects an empty message; a 400 here is otherwise invisible.
        message: message || "Unknown error",
        stack,
        level: options.level ?? "error",
        context: { ...context, ...detail },
      }),
    });
    if (!res.ok) {
      // Never report the reporter's own failure — that is how a loop starts.
      logError("error_report_failed", { status: res.status });
    }
  } catch {
    // Reporting must never disturb the caller. Swallow transport failures.
  }
}
