// Brave Search adapter for the WebSearch port. Calls the Brave Web Search API
// and normalizes its payload to SearchResult[]. Uses the global Workers fetch.
//
// Brave enforces a per-second rate limit (50 req/s on the Search plan,
// `x-ratelimit-policy: 50;w=1`), so a burst of web_search calls in a single
// research loop can still trip HTTP 429 (`code: RATE_LIMITED`). Those clear in
// ~1s, so the adapter waits and retries them transparently. A monthly quota
// only exists on plans that have one; where it does, exhausting it also returns
// 429 but is not transient, so it throws immediately. Plans without a monthly
// cap report `quota_limit: 0`, which is not exhaustion. See docs/research.md.

import { log, logError } from "../log";
import type { SearchResult, WebSearch } from "./types";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_COUNT = 5;

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DELAY_MS = 1000;
const JITTER_MS = 250;

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BravePayload {
  web?: { results?: BraveWebResult[] };
}

interface BraveErrorBody {
  error?: {
    code?: string;
    meta?: {
      quota_limit?: number;
      quota_current?: number;
    };
  };
}

export interface BraveSearchOptions {
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  defaultDelayMs?: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// First CSV component of `x-ratelimit-reset` is seconds until the 1-req/s
// window resets (Brave sends no Retry-After). Falls back to the default when
// the header is missing or unparseable.
const resetDelayMs = (header: string | null, fallbackMs: number): number => {
  if (!header) return fallbackMs;
  const seconds = Number.parseInt(header.split(",")[0]?.trim() ?? "", 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return seconds * 1000;
};

export const createBraveSearch = (
  apiKey: string,
  options: BraveSearchOptions = {},
): WebSearch => {
  const sleep = options.sleep ?? realSleep;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const defaultDelayMs = options.defaultDelayMs ?? DEFAULT_DELAY_MS;

  return {
    async search(query: string): Promise<SearchResult[]> {
      const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${DEFAULT_COUNT}`;

      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        });

        if (res.ok) {
          const data: BravePayload = await res.json();
          const results = data.web?.results ?? [];
          return results.map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            snippet: r.description ?? "",
          }));
        }

        const failed = () =>
          new Error(`Brave search failed: ${res.status} ${res.statusText}`);

        if (res.status !== 429) throw failed();

        const body = (await res.json().catch(() => ({}))) as BraveErrorBody;
        const meta = body.error?.meta;
        if (
          meta &&
          typeof meta.quota_current === "number" &&
          typeof meta.quota_limit === "number" &&
          meta.quota_limit > 0 &&
          meta.quota_current >= meta.quota_limit
        ) {
          logError("brave_quota_exhausted", {
            quota_current: meta.quota_current,
            quota_limit: meta.quota_limit,
          });
          throw failed();
        }

        if (attempt >= maxRetries) throw failed();

        const delayMs =
          resetDelayMs(res.headers.get("x-ratelimit-reset"), defaultDelayMs) +
          Math.floor(Math.random() * JITTER_MS);
        log("brave_rate_limited", { attempt, delay_ms: delayMs });
        await sleep(delayMs);
      }
    },
  };
};
