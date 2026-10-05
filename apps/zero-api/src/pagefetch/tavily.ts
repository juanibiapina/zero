// Tavily Extract adapter for the PageFetcher port. Calls Tavily's Extract
// endpoint for a single URL and normalizes the cleaned markdown to PageContent.
// Uses the global Workers fetch. See docs/research.md.
//
// Addresses are normalized first (see normalizeWebAddress), so shorthand like
// `thing.com/path` reaches Tavily as a full HTTPS URL and non-HTTP(S) schemes
// or embedded credentials never leave the Worker.
//
// Depth is `basic` (cheaper, enough to read article text) and `query` is
// omitted so the full page comes back rather than query-reranked chunks. The
// returned content is hard-capped so a pathological page can't blow the turn's
// context. Transient 429/5xx get a small bounded retry; other non-2xx throw.

import { log } from "../log";
import type { PageContent, PageFetcher } from "./types";

const ENDPOINT = "https://api.tavily.com/extract";
const DEFAULT_MAX_CONTENT_CHARS = 8000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_DELAY_MS = 500;

interface TavilyResult {
  url?: string;
  raw_content?: string;
}

interface TavilyPayload {
  results?: TavilyResult[];
  failed_results?: unknown[];
}

export interface TavilyFetcherOptions {
  maxContentChars?: number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  delayMs?: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Errors never echo the submitted address: it reaches logs and prompts, and a
// user-supplied string is not something to reflect back.
const INVALID_ADDRESS = "page fetch failed: invalid web address";

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// Accept both complete URLs ("https://thing.com/path") and the shorthand people
// actually type ("thing.com/path", "//thing.com/path"). Syntax and protocol
// validation only: Tavily still owns remote-fetch policy.
export const normalizeWebAddress = (address: string): string => {
  const trimmed = address.trim();
  if (!trimmed) throw new Error(INVALID_ADDRESS);

  let candidate: string;
  if (trimmed.startsWith("//")) {
    candidate = `https:${trimmed}`;
  } else if (/^https?:\/\//i.test(trimmed)) {
    candidate = trimmed;
  } else if (SCHEME.test(trimmed) && trimmed.slice(trimmed.indexOf(":") + 1).startsWith("//")) {
    // Some other scheme (ftp://, file://): rejected outright.
    throw new Error(INVALID_ADDRESS);
  } else {
    candidate = `https://${trimmed}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(INVALID_ADDRESS);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(INVALID_ADDRESS);
  }
  if (url.username || url.password) throw new Error(INVALID_ADDRESS);
  return url.toString();
};

// Matches the truncateBody convention in prompts.ts so truncated pages read the
// same everywhere.
const truncate = (text: string, cap: number): string =>
  text.length > cap ? `${text.slice(0, cap)}…[truncated]` : text;

export const createTavilyFetcher = (
  apiKey: string,
  options: TavilyFetcherOptions = {},
): PageFetcher => {
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const sleep = options.sleep ?? realSleep;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  return {
    async fetch(address: string): Promise<PageContent> {
      if (!apiKey) {
        throw new Error(
          "page fetch unavailable: TAVILY_API_KEY not configured",
        );
      }

      const url = normalizeWebAddress(address);

      for (let attempt = 0; ; attempt++) {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            urls: url,
            extract_depth: "basic",
            format: "markdown",
          }),
        });

        if (res.ok) {
          const data: TavilyPayload = await res.json();
          const raw = data.results?.[0]?.raw_content;
          if (typeof raw !== "string" || raw.length === 0) {
            throw new Error("page fetch failed: no content returned");
          }
          return { url, content: truncate(raw, maxContentChars) };
        }

        const failed = () =>
          new Error(`page fetch failed: ${res.status} ${res.statusText}`);

        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= maxRetries) throw failed();

        log("page_fetch_retry", { attempt, status: res.status });
        await sleep(delayMs);
      }
    },
  };
};
