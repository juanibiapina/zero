// ZeroErrors reporting.
//
// Fire-and-forget exception reporting to ZeroErrors, dogfooding the suite's own
// error tracker. Reporting is a no-op unless ZEROERRORS_KEY is set on the
// worker, and the returned promise never rejects, so it can be awaited in a
// Durable Object alarm or handed to `executionCtx.waitUntil` from an HTTP
// handler without ever disturbing the caller's error path.
//
// ZEROERRORS_KEY is a `zv_` API key scoped to the ZeroErrors "zero-agent"
// project's org (the same key family that authorizes ZeroVault). Ingest matches
// the /v1/errors contract in @zero/errors-core.

import { fmtErr } from "../log";

const ENDPOINT = "https://zeroerrors.juanibiapina.dev/v1/errors";
const PROJECT = "zero-agent";

// Only the field the reporter reads. Declared locally so this module never
// depends on the secret being present in the wrangler-generated Env type; the
// value is present at runtime whenever the secret is set on the worker.
interface ReportEnv {
  ZEROERRORS_KEY?: string;
}

export async function reportError(
  env: ReportEnv,
  err: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const key = env.ZEROERRORS_KEY;
  if (!key) return;

  // fmtErr pulls out message/stack plus any AI-SDK/API detail (status code,
  // rate-limit headers, response body). Keep message/stack as the event's
  // top-level fields and fold the rest into context for the dashboard.
  const { message, stack, ...detail } = fmtErr(err);

  try {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
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
