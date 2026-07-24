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

import { fmtErr } from "../log";

const ENDPOINT = "https://api.zeroapps.dev/errors/v1/errors";
const PROJECT = "zero-agent";

export async function reportError(
  env: { ZEROVAULT_API_KEY: string },
  err: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  // fmtErr pulls out message/stack plus any AI-SDK/API detail (status code,
  // rate-limit headers, response body). Keep message/stack as the event's
  // top-level fields and fold the rest into context for the dashboard.
  const { message, stack, ...detail } = fmtErr(err);

  try {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ZEROVAULT_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        project: PROJECT,
        message,
        stack,
        context: { ...context, ...detail },
      }),
    });
  } catch {
    // Reporting must never disturb the caller. Swallow transport failures.
  }
}
