/**
 * ============================================================================
 * ZeroErrors Core — Shared Types
 * ============================================================================
 *
 * Types shared between the API worker and the web dashboard, plus the pure
 * fingerprint function used for grouping.
 */

import { z } from "zod";

export * from "./fingerprint";

// ============================================================================
// Domain enums
// ============================================================================

export type ErrorLevel = "error" | "warning" | "info";
export type IssueStatus = "open" | "resolved";

/**
 * A structured-cloneable JSON value. Used for arbitrary event context so it
 * survives Durable Object RPC (Cloudflare's RPC types reject bare `unknown`).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// ============================================================================
// Ingest payload (POST /v1/errors)
// ============================================================================

export const errorReportSchema = z.object({
  project: z.string().min(1).max(200),
  message: z.string().min(1).max(10_000),
  stack: z.string().max(50_000).optional(),
  level: z.enum(["error", "warning", "info"]).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorReport = z.infer<typeof errorReportSchema>;

// ============================================================================
// Read models (API responses)
// ============================================================================

export interface IssueSummary {
  id: string;
  fingerprint: string;
  project: string;
  title: string;
  level: ErrorLevel;
  status: IssueStatus;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * A stored event as it crosses the ErrorsDO RPC boundary: primitive fields only
 * (context stays a raw JSON string). Cloudflare's RPC types choke on recursive
 * JSON types, so parsing to `EventSummary` happens at the HTTP layer.
 */
export interface StoredEvent {
  id: string;
  issueId: string;
  message: string;
  stack: string | null;
  contextJson: string | null;
  userId: string;
  createdAt: string;
}

/** An event as returned by the HTTP read API, with context parsed to JSON. */
export interface EventSummary {
  id: string;
  issueId: string;
  message: string;
  stack: string | null;
  context: JsonObject | null;
  userId: string;
  createdAt: string;
}

/** Parse a StoredEvent's raw context JSON into an EventSummary. */
export function toEventSummary(e: StoredEvent): EventSummary {
  let context: JsonObject | null = null;
  if (e.contextJson) {
    try {
      context = JSON.parse(e.contextJson) as JsonObject;
    } catch {
      context = null;
    }
  }
  return {
    id: e.id,
    issueId: e.issueId,
    message: e.message,
    stack: e.stack,
    context,
    userId: e.userId,
    createdAt: e.createdAt,
  };
}

// ============================================================================
// API response envelopes
// ============================================================================

export interface IngestResponse {
  issueId: string;
  isNew: boolean;
}

export interface IssueListResponse {
  issues: IssueSummary[];
}

export interface IssueDetailResponse {
  issue: IssueSummary;
  events: EventSummary[];
}

export interface ErrorResponse {
  error: string;
}
