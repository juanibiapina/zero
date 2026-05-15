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
 * The handler is wired onto the Container class as `static outbound` and
 * is the catch-all: anything in `static outboundByHost` (currently just
 * `zero.worker`) takes precedence and bypasses substitution.
 */

import type { OutboundHandler } from "@cloudflare/containers";
import type { Env } from "./types";

const SENTINEL_PREFIX = "Z3R0-FAKE-";

const fakeFor = (envName: string): string => SENTINEL_PREFIX + envName;

export interface SecretProxy {
  /**
   * Sentinel values keyed by env-var name. Inject these into the
   * container's `envVars` so the in-container process sees the fake
   * instead of the real secret.
   */
  readonly fakes: Readonly<Record<string, string>>;
  /**
   * Catch-all outbound handler. Wire onto the Container subclass as
   * `static outbound = secretProxy.outbound`. Forwards every request
   * after substituting registered fakes for their real env values.
   */
  readonly outbound: OutboundHandler<Env>;
}

export const createSecretProxy = (
  envNames: readonly (keyof Env)[],
): SecretProxy => {
  const encoder = new TextEncoder();
  const fakes: Record<string, string> = {};
  const fakeBytesByName: Record<string, Uint8Array> = {};
  for (const name of envNames) {
    const fake = fakeFor(name);
    fakes[name] = fake;
    fakeBytesByName[name] = encoder.encode(fake);
  }

  const outbound: OutboundHandler<Env> = async (req, env, ctx) => {
    // Resolve real values from env now, at call time. Drop secrets whose
    // env is missing so we never substitute an empty string into a request.
    const pairs: SubstitutionPair[] = [];
    for (const name of envNames) {
      const real = env[name];
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
    let host = "?";
    try {
      host = new URL(url).host;
    } catch {
      /* leave as ? */
    }
    console.log(
      `[secret-proxy] forwarded host=${host} containerId=${ctx.containerId} method=${req.method} matches=${totalMatches.toString()}`,
    );

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
