// Brave Search adapter for the WebSearch port. Calls the Brave Web Search API
// and normalizes its payload to SearchResult[]. Uses the global Workers fetch.
//
// Brave enforces a per-second rate limit (50 req/s on the Search plan,
// `x-ratelimit-policy: 50;w=1`), so a burst of web_search calls in a single
// turn can still trip HTTP 429 (`code: RATE_LIMITED`). Those clear in
// ~1s, so the adapter waits and retries them transparently. A monthly quota
// only exists on plans that have one; where it does, exhausting it also returns
// 429 but is not transient, so it throws immediately. Plans without a monthly
// cap report `quota_limit: 0`, which is not exhaustion. See docs/research.md.
//
// This is the only code that talks to Brave, so it is also the only place that
// can count requests: every HTTP attempt, success included, emits one
// `brave_request` line. Brave bills per request, and one logical search can cost
// up to 4 of them after retries, so a log per *search* would undercount. Each
// line carries Brave's own accounting headers rather than a count of our own.
// See docs/research.md (Observability).

import { log, logError } from "../log";
import { queryHash } from "../query-hash";
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

interface BraveErrorMeta {
  plan?: string;
  rate_limit?: number;
  rate_current?: number;
  quota_limit?: number;
  quota_current?: number;
}

interface BraveErrorBody {
  error?: {
    code?: string;
    meta?: BraveErrorMeta;
  };
}

export interface BraveSearchOptions {
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  defaultDelayMs?: number;
  // Which key cohort this adapter uses ("paid" | "free"), tagged onto every
  // Brave log line so paid-plan spend is countable per cohort. Omitted when not
  // supplied. See docs/plans/brave-paid-canary.md.
  cohort?: string;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Brave's rate-limit headers are two-component CSVs: the per-second window
// first, the monthly window second (`x-ratelimit-limit: 50, 0`,
// `x-ratelimit-policy: 50;w=1, 0;w=2678400`). A component that is missing or
// unparseable comes back undefined rather than NaN, so it drops out of the log
// line instead of poisoning it.
interface RateWindows {
  sec?: number;
  month?: number;
}

const parseWindows = (header: string | null): RateWindows => {
  if (!header) return {};
  const parts = header.split(",");
  const num = (raw: string | undefined): number | undefined => {
    const parsed = Number.parseInt(raw?.trim() ?? "", 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return { sec: num(parts[0]), month: num(parts[1]) };
};

// Seconds until the 1-req/s window resets (Brave sends no Retry-After). Falls
// back to the default when the header is missing or unparseable.
const resetDelayMs = (reset: RateWindows, fallbackMs: number): number => {
  const seconds = reset.sec;
  if (seconds === undefined || seconds <= 0) return fallbackMs;
  return seconds * 1000;
};

// Brave's own upstream latency, e.g. `server-timing: search-roundtrip;dur=549.9`.
// Separating it from our wall clock is the only way to tell "Brave is slow" from
// "we are queued behind our own retries".
const upstreamMs = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const match = /dur=([\d.]+)/.exec(header);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
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
      const hash = queryHash(query);
      // `cohort` is spread into every Brave log line via queryFields; omitted
      // when not supplied so existing callers/log shapes are unchanged.
      const queryFields = {
        query_hash: hash,
        query_len: query.length,
        ...(options.cohort !== undefined ? { cohort: options.cohort } : {}),
      };
      const started = Date.now();

      for (let attempt = 0; ; attempt++) {
        const attemptStarted = Date.now();
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        });

        const limit = parseWindows(res.headers.get("x-ratelimit-limit"));
        const remaining = parseWindows(res.headers.get("x-ratelimit-remaining"));
        const reset = parseWindows(res.headers.get("x-ratelimit-reset"));

        // `result_count` is filled in below for a 200; a zero here is a search
        // that worked and found nothing, which is invisible from the tool side
        // and a plausible reason for the agent to keep re-searching.
        const requestFields: Record<string, unknown> = {
          ...queryFields,
          attempt,
          status: res.status,
          duration_ms: Date.now() - attemptStarted,
          upstream_ms: upstreamMs(res.headers.get("server-timing")),
          rate_limit_sec: limit.sec,
          rate_limit_month: limit.month,
          rate_remaining_sec: remaining.sec,
          rate_remaining_month: remaining.month,
          rate_reset_sec: reset.sec,
          rate_reset_month: reset.month,
        };

        if (res.ok) {
          const data: BravePayload = await res.json();
          const results = data.web?.results ?? [];
          log("brave_request", {
            ...requestFields,
            result_count: results.length,
          });
          return results.map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            snippet: r.description ?? "",
          }));
        }

        log("brave_request", requestFields);

        const failed = () => {
          logError("brave_request_failed", {
            ...queryFields,
            status: res.status,
            attempts: attempt + 1,
            total_duration_ms: Date.now() - started,
          });
          return new Error(
            `Brave search failed: ${res.status} ${res.statusText}`,
          );
        };

        if (res.status !== 429) throw failed();

        const body = (await res.json().catch(() => ({}))) as BraveErrorBody;
        const meta = body.error?.meta;
        // Brave reports the per-second and the monthly limit in the same 429.
        // These fields are what tells them apart, and `quota_limit: 0` (no
        // monthly cap) is the value that once made every burst 429 look like
        // exhaustion — log it so a repeat is visible.
        const metaFields = {
          plan: meta?.plan,
          rate_limit: meta?.rate_limit,
          rate_current: meta?.rate_current,
          quota_limit: meta?.quota_limit,
          quota_current: meta?.quota_current,
        };

        if (
          meta &&
          typeof meta.quota_current === "number" &&
          typeof meta.quota_limit === "number" &&
          meta.quota_limit > 0 &&
          meta.quota_current >= meta.quota_limit
        ) {
          logError("brave_quota_exhausted", { ...queryFields, ...metaFields });
          throw failed();
        }

        if (attempt >= maxRetries) throw failed();

        const delayMs =
          resetDelayMs(reset, defaultDelayMs) +
          Math.floor(Math.random() * JITTER_MS);
        log("brave_rate_limited", {
          ...queryFields,
          ...metaFields,
          attempt,
          delay_ms: delayMs,
        });
        await sleep(delayMs);
      }
    },
  };
};
