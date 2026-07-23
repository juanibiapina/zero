// ZeroErrors reporting.
//
// Fire-and-forget exception reporting to ZeroErrors, dogfooding the suite's own
// error tracker. The returned promise never rejects, so it can be handed to
// `executionCtx.waitUntil` from an HTTP handler without ever disturbing the
// caller's error path.
//
// ZEROVAULT_API_KEY is a required secret (see wrangler.jsonc secrets.required):
// the same `zv_` org key that unlocks ZeroVault also authorizes ZeroErrors
// ingest, since both validate against the shared APIKEYS store. There is no
// missing-key branch here — a missing key is a deploy-time failure, not a
// runtime state. The try/catch below is runtime resilience against a ZeroErrors
// outage, not an opt-out.

const ENDPOINT = "https://errors.apps.juanibiapina.dev/v1/errors";
const PROJECT = "zerovault";

function extract(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

export async function reportError(
  env: { ZEROVAULT_API_KEY: string },
  err: unknown,
  context: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { message, stack } = extract(err);

  try {
    await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ZEROVAULT_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        project: PROJECT,
        message,
        stack,
        context,
      }),
    });
  } catch {
    // Reporting must never disturb the caller. Swallow transport failures.
  }
}
