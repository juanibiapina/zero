/**
 * ============================================================================
 * ErrorsDO — Per-Org Issue Store
 * ============================================================================
 *
 * One ErrorsDO instance per organization (keyed by orgId). Groups occurrences
 * into issues by fingerprint and keeps a capped tail of recent events per
 * issue. There is no project registry — `project` is a freeform label on each
 * issue, so no registration step and no cross-DO orchestration.
 *
 * The fingerprint is computed by the caller (pure function in core) and passed
 * in; the DO owns only storage and the upsert/prune/reopen transitions.
 */

import { DurableObject } from "cloudflare:workers";
import { createDb, migrate, eq, and, asc, desc, type Database } from "do-orm";
import { migrations } from "./db/migrations";
import { issuesTable, eventsTable } from "./db/schema";
import type { Env } from "../types";
import type {
  IssueSummary,
  StoredEvent,
  ErrorLevel,
  IssueStatus,
} from "@zero/errors-core";

/** Keep at most this many recent events per issue; older ones are pruned. */
const EVENT_CAP = 50;

type IssueRow = {
  id: string;
  fingerprint: string;
  project: string;
  title: string;
  level: string;
  status: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
};

export interface RecordInput {
  fingerprint: string;
  project: string;
  title: string;
  level: ErrorLevel;
  message: string;
  stack?: string | null;
  contextJson?: string | null;
  userId: string;
  now: string;
}

export interface RecordResult {
  issue: IssueSummary;
  isNew: boolean;
  isRegression: boolean;
}

export class ErrorsDO extends DurableObject<Env> {
  db: Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);

    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, migrations);
    });
  }

  // ============================================================================
  // Ingest
  // ============================================================================

  /**
   * Upserts the issue for `fingerprint` (insert new, or bump count +
   * last_seen), records the event, prunes old events, and reports whether the
   * issue is new or a regression (a new occurrence on a resolved issue, which
   * auto-reopens it). The caller notifies on isNew || isRegression.
   */
  record(input: RecordInput): RecordResult {
    const existing = this.db.get(issuesTable, {
      where: eq("fingerprint", input.fingerprint),
    });

    let issueRow: IssueRow;
    let isNew: boolean;
    let isRegression: boolean;

    if (!existing) {
      issueRow = {
        id: crypto.randomUUID(),
        fingerprint: input.fingerprint,
        project: input.project,
        title: input.title,
        level: input.level,
        status: "open",
        count: 1,
        first_seen_at: input.now,
        last_seen_at: input.now,
      };
      this.db.insert(issuesTable, issueRow);
      isNew = true;
      isRegression = false;
    } else {
      isNew = false;
      isRegression = existing.status === "resolved";
      issueRow = {
        ...existing,
        count: existing.count + 1,
        last_seen_at: input.now,
        status: "open",
      };
      this.db.update(
        issuesTable,
        { count: issueRow.count, last_seen_at: input.now, status: "open" },
        { where: eq("id", existing.id) },
      );
    }

    this.db.insert(eventsTable, {
      id: crypto.randomUUID(),
      issue_id: issueRow.id,
      message: input.message,
      stack: input.stack ?? null,
      context_json: input.contextJson ?? null,
      user_id: input.userId,
      created_at: input.now,
    });

    this.pruneEvents(issueRow.id);

    return { issue: toIssueSummary(issueRow), isNew, isRegression };
  }

  private pruneEvents(issueId: string): void {
    const total = this.db.count(eventsTable, { where: eq("issue_id", issueId) });
    if (total <= EVENT_CAP) return;

    const excess = total - EVENT_CAP;
    const oldest = this.db.select(eventsTable, ["id"], {
      where: eq("issue_id", issueId),
      orderBy: asc("created_at"),
      limit: excess,
    });
    for (const row of oldest) {
      this.db.delete(eventsTable, { where: eq("id", row.id) });
    }
  }

  // ============================================================================
  // Read
  // ============================================================================

  listIssues(filter: { project?: string; status?: IssueStatus } = {}): IssueSummary[] {
    const conditions = [];
    if (filter.project) conditions.push(eq("project", filter.project));
    if (filter.status) conditions.push(eq("status", filter.status));
    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const rows = this.db.select(
      issuesTable,
      [
        "id",
        "fingerprint",
        "project",
        "title",
        "level",
        "status",
        "count",
        "first_seen_at",
        "last_seen_at",
      ],
      { where, orderBy: desc("last_seen_at") },
    ) as IssueRow[];

    return rows.map(toIssueSummary);
  }

  getIssue(
    id: string,
  ): { issue: IssueSummary; events: StoredEvent[] } | null {
    const row = this.db.get(issuesTable, { where: eq("id", id) });
    if (!row) return null;

    const events = this.db.select(
      eventsTable,
      ["id", "issue_id", "message", "stack", "context_json", "user_id", "created_at"],
      { where: eq("issue_id", id), orderBy: desc("created_at"), limit: EVENT_CAP },
    );

    return {
      issue: toIssueSummary(row),
      events: events.map(toStoredEvent),
    };
  }

  /**
   * Resolve or reopen an issue. Returns the updated summary, or null if the
   * issue does not exist.
   */
  setStatus(id: string, status: IssueStatus): IssueSummary | null {
    const row = this.db.get(issuesTable, { where: eq("id", id) });
    if (!row) return null;

    this.db.update(issuesTable, { status }, { where: eq("id", id) });
    return toIssueSummary({ ...row, status });
  }
}

// ============================================================================
// Row mappers
// ============================================================================

function toIssueSummary(row: IssueRow): IssueSummary {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    project: row.project,
    title: row.title,
    level: row.level as ErrorLevel,
    status: row.status as IssueStatus,
    count: row.count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toStoredEvent(row: {
  id: string;
  issue_id: string;
  message: string;
  stack: string | null;
  context_json: string | null;
  user_id: string;
  created_at: string;
}): StoredEvent {
  return {
    id: row.id,
    issueId: row.issue_id,
    message: row.message,
    stack: row.stack,
    contextJson: row.context_json,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}
