/**
 * ============================================================================
 * Secret Proxy
 * ============================================================================
 *
 * The container process (pi-coding-agent + anything it spawns) must never see
 * the real value of any registered secret. Instead it sees a constant fake
 * sentinel — `Z3R0-FAKE-<ENV_NAME>` — that the worker's catch-all outbound
 * handler swaps for the real value, byte-for-byte, on the way out.
 *
 *   container env: ANTHROPIC_API_KEY=Z3R0-FAKE-ANTHROPIC_API_KEY
 *
 *   outbound request to api.anthropic.com:
 *     x-api-key: Z3R0-FAKE-ANTHROPIC_API_KEY        ← becomes …
 *     x-api-key: <env.ANTHROPIC_API_KEY>            ← real value, only here
 *
 * Substitution runs across URL, header values, and body bytes. The
 * `Z3R0-FAKE-` prefix makes accidental matches in unrelated payloads
 * essentially impossible while staying trivially greppable in logs.
 *
 * The fake is *not* a credential — it's a sentinel marker. It can leak,
 * appear in two containers at once, or be guessed; the only way to turn
 * it into the real value is to be this catch-all handler running inside
 * the worker.
 *
 * Two categories of registered secret:
 *
 *  - `envSecrets` — real value lives in worker `env`. Resolved on every
 *    outbound. Used for app-wide secrets like `ANTHROPIC_API_KEY`.
 *
 *  - `runtimeSecrets` — real value is per-container and not in `env`
 *    (e.g. a per-user Google OAuth access token fetched live from
 *    Clerk). Pushed to the container's outbound config via
 *    `Container.setOutboundHandler('substitute', { overrides })`, and
 *    arrives in this handler as `ctx.params.overrides[name]`. The
 *    handler must be registered as `static outboundHandlers.substitute`
 *    so `setOutboundHandler` can find it by name.
 *
 * Anything in `static outboundByHost` (currently `zero.worker` and the
 * R2 pass-through) takes precedence and bypasses substitution.
 */

import type { OutboundHandler } from "@cloudflare/containers";
import { logError } from "./log";
import type { Env } from "./types";

const SENTINEL_PREFIX = "Z3R0-FAKE-";

const fakeFor = (envName: string): string => SENTINEL_PREFIX + envName;

/**
 * Params accepted by the substitute handler when registered as a named
 * outbound handler. AgentContainer pushes the per-container override
 * map via `setOutboundHandler('substitute', { overrides })`.
 */
export interface SubstituteParams {
  /**
   * Map of runtime-secret name → real value. Names must match those
   * passed as `runtimeSecrets` to `createSecretProxy`.
   */
  overrides?: Record<string, string>;
}

export interface SecretProxy {
  /**
   * Sentinel values keyed by env-var name. Inject these into the
   * container's `envVars` so the in-container process sees the fake
   * instead of the real secret. Includes entries for both env- and
   * runtime-resolved secrets.
   */
  readonly fakes: Readonly<Record<string, string>>;
  /**
   * Catch-all outbound handler. Register on the Container subclass as a
   * named handler so `setOutboundHandler('substitute', { overrides })`
   * can target it:
   *
   *   static outboundHandlers = { substitute: secretProxy.outbound };
   *
   * The DO's `fetch` is expected to await `setOutboundHandler` before
   * delegating to `super.fetch`, so there is no need to also wire it as
   * `static outbound` — the named override is always set before the
   * container makes any outbound request.
   */
  readonly outbound: OutboundHandler<Env, SubstituteParams>;
}

export const createSecretProxy = (
  envSecrets: readonly (keyof Env)[],
  runtimeSecrets: readonly string[] = [],
): SecretProxy => {
  const encoder = new TextEncoder();
  const fakes: Record<string, string> = {};
  const fakeBytesByName: Record<string, Uint8Array> = {};
  for (const name of [...envSecrets, ...runtimeSecrets]) {
    const fake = fakeFor(name);
    fakes[name] = fake;
    fakeBytesByName[name] = encoder.encode(fake);
  }

  const outbound: OutboundHandler<Env, SubstituteParams> = async (
    req,
    env,
    ctx,
  ) => {
    // Resolve real values for every registered secret. Drop secrets whose
    // real value is missing/empty so we never substitute an empty string
    // into a request — the unsubstituted sentinel reaches the upstream
    // and gets rejected as a bad credential, which is the right signal.
    const pairs: SubstitutionPair[] = [];

    // env-resolved (app-wide)
    for (const name of envSecrets) {
      const real = env[name];
      if (typeof real !== "string" || real.length === 0) continue;
      pairs.push({
        fake: fakes[name],
        fakeBytes: fakeBytesByName[name],
        real,
        realBytes: encoder.encode(real),
      });
    }

    // runtime-resolved (per-container, pushed via ctx.params)
    const overrides = ctx.params?.overrides ?? {};
    for (const name of runtimeSecrets) {
      const real = overrides[name];
      if (typeof real !== "string" || real.length === 0) continue;
      pairs.push({
        fake: fakes[name],
        fakeBytes: fakeBytesByName[name],
        real,
        realBytes: encoder.encode(real),
      });
    }

    // ── URL ──
    let url = req.url;
    let urlMatches = 0;
    for (const p of pairs) {
      if (url.includes(p.fake)) {
        const before = url;
        url = url.split(p.fake).join(p.real);
        urlMatches += countOccurrences(before, p.fake);
      }
    }

    // ── Headers ──
    const headers = new Headers(req.headers);
    let headerMatches = 0;
    for (const [name, value] of headers.entries()) {
      let updated = value;
      for (const p of pairs) {
        if (updated.includes(p.fake)) {
          headerMatches += countOccurrences(updated, p.fake);
          updated = updated.split(p.fake).join(p.real);
        }
      }
      if (updated !== value) {
        headers.set(name, updated);
      }
    }

    // ── Body ──
    // Buffer once. Workers can't forward a request body without consuming
    // it, and we need raw bytes anyway to do substitution that's safe for
    // both text and binary payloads.
    let body: BodyInit | null = null;
    let bodyMatches = 0;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const buf = new Uint8Array(await req.arrayBuffer());
      const result = substituteBytes(buf, pairs);
      bodyMatches = result.matches;
      body = result.bytes.byteLength > 0 ? result.bytes : null;
      // The original Content-Length (if any) refers to the pre-substitution
      // body. Drop it and let `fetch` recompute from the new body.
      headers.delete("content-length");
    }

    const totalMatches = urlMatches + headerMatches + bodyMatches;
    if (totalMatches === 0) {
      let host: string | null = null;
      try {
        host = new URL(url).host;
      } catch {
        /* leave null */
      }
      logError("secret_proxy_no_substitutions", {
        host,
        container_id: ctx.containerId,
        method: req.method,
        note: "secret may have leaked or stopped flowing",
      });
    }

    return fetch(url, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });
  };

  return { fakes, outbound };
};

// ── Byte-level substitution ─────────────────────────────────────────────

interface SubstitutionPair {
  fake: string;
  fakeBytes: Uint8Array;
  real: string;
  realBytes: Uint8Array;
}

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count += 1;
    pos += needle.length;
  }
  return count;
};

/**
 * Apply each pair's fake→real substitution to `input`, in registration
 * order. Pairs cannot overlap meaningfully because every fake is
 * `Z3R0-FAKE-<NAME>` and names are unique env-var identifiers — but we
 * still apply them sequentially so the implementation stays trivial.
 */
const substituteBytes = (
  input: Uint8Array,
  pairs: readonly SubstitutionPair[],
): { bytes: Uint8Array; matches: number } => {
  let current = input;
  let total = 0;
  for (const p of pairs) {
    const result = replaceAllBytes(current, p.fakeBytes, p.realBytes);
    current = result.bytes;
    total += result.matches;
  }
  return { bytes: current, matches: total };
};

const replaceAllBytes = (
  input: Uint8Array,
  needle: Uint8Array,
  replacement: Uint8Array,
): { bytes: Uint8Array; matches: number } => {
  if (needle.length === 0 || input.length < needle.length) {
    return { bytes: input, matches: 0 };
  }

  // Find non-overlapping match offsets via a naive scan. Inputs here are
  // bounded by request-body size; pi-anthropic bodies are well under 1 MB,
  // and the alternative (text decode + String.indexOf) loses binary
  // fidelity for free.
  const offsets: number[] = [];
  const last = input.length - needle.length;
  let i = 0;
  scan: while (i <= last) {
    for (let j = 0; j < needle.length; j++) {
      if (input[i + j] !== needle[j]) {
        i += 1;
        continue scan;
      }
    }
    offsets.push(i);
    i += needle.length;
  }
  if (offsets.length === 0) {
    return { bytes: input, matches: 0 };
  }

  const sizeDelta = offsets.length * (replacement.length - needle.length);
  const out = new Uint8Array(input.length + sizeDelta);
  let inPos = 0;
  let outPos = 0;
  for (const off of offsets) {
    const span = off - inPos;
    if (span > 0) {
      out.set(input.subarray(inPos, off), outPos);
      outPos += span;
    }
    out.set(replacement, outPos);
    outPos += replacement.length;
    inPos = off + needle.length;
  }
  if (inPos < input.length) {
    out.set(input.subarray(inPos), outPos);
  }

  return { bytes: out, matches: offsets.length };
};
