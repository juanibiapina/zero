// Catch-all outbound handler that substitutes constant sentinels of the
// form `Z3R0-FAKE-<NAME>` for the real secret value byte-for-byte in URL,
// headers, and body. The container only ever sees the sentinel; the real
// value lives in worker `env` (envSecrets) or in a per-container override
// map pushed via `setOutboundHandler('substitute', { overrides })`
// (runtimeSecrets). Full design in docs/design.md § Secret Proxying.

import type { OutboundHandler } from "@cloudflare/containers";
import { logError } from "./log";
import type { Env } from "./types";

const SENTINEL_PREFIX = "Z3R0-FAKE-";

const fakeFor = (envName: string): string => SENTINEL_PREFIX + envName;

export interface SubstituteParams {
  /** Runtime-secret name → real value. Keys must match `runtimeSecrets`. */
  overrides?: Record<string, string>;
}

export interface SecretProxy {
  /** Sentinel values keyed by env-var name; inject into the container env. */
  readonly fakes: Readonly<Record<string, string>>;
  /** Register as a named handler: `static outboundHandlers.substitute`. */
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
    // Drop secrets whose real value is missing/empty so the unsubstituted
    // sentinel reaches the upstream and gets rejected as a bad credential.
    const pairs: SubstitutionPair[] = [];

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

    let url = req.url;
    let urlMatches = 0;
    for (const p of pairs) {
      if (url.includes(p.fake)) {
        const before = url;
        url = url.split(p.fake).join(p.real);
        urlMatches += countOccurrences(before, p.fake);
      }
    }

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

    let body: BodyInit | null = null;
    let bodyMatches = 0;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const buf = new Uint8Array(await req.arrayBuffer());
      const result = substituteBytes(buf, pairs);
      bodyMatches = result.matches;
      body = result.bytes.byteLength > 0 ? result.bytes : null;
      // Content-Length refers to the pre-substitution body; drop it.
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

// Apply each pair's fake→real substitution sequentially.
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

  // Naive byte scan; bodies are small (well under 1 MB) and a text
  // decode would lose binary fidelity.
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
