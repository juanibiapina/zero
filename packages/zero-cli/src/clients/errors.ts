/**
 * ============================================================================
 * ZeroErrors API client
 * ============================================================================
 *
 * Every path is prefixed `/errors/v1`. Ingest limits (project 1-200 chars,
 * message 1-10000, stack <=50000) are enforced by the server; this client
 * sends what it is given and lets a 400 surface as an ApiError, so the CLI
 * never disagrees with the API about what is valid.
 *
 * Response shapes are declared inline: this package publishes to npm with
 * `commander` as its only runtime dependency and must not import the
 * unpublished `@zero/errors-core`.
 */

import { HttpClient } from "./http.js";

const P = "/errors/v1";

export type ErrorLevel = "error" | "warning" | "info";
export type IssueStatus = "open" | "resolved";

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

export interface EventSummary {
  id: string;
  message: string;
  stack: string | null;
  level: ErrorLevel;
  context: Record<string, unknown> | null;
  receivedAt: string;
}

export interface ErrorReport {
  project: string;
  message: string;
  stack?: string;
  level?: ErrorLevel;
  context?: Record<string, unknown>;
}

export class ErrorsClient {
  private http: HttpClient;

  constructor(baseUrl: string, apiKey: string) {
    this.http = new HttpClient(baseUrl, apiKey);
  }

  async whoami() {
    return this.http.request<{ userId: string; orgId: string }>(`${P}/whoami`);
  }

  async report(report: ErrorReport) {
    return this.http.request<{ issueId: string; isNew: boolean }>(`${P}/errors`, {
      method: "POST",
      body: report,
    });
  }

  async listIssues(filters: { project?: string; status?: IssueStatus } = {}) {
    const query = new URLSearchParams();
    if (filters.project) query.set("project", filters.project);
    if (filters.status) query.set("status", filters.status);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.http.request<{ issues: IssueSummary[] }>(`${P}/issues${suffix}`);
  }

  async getIssue(id: string) {
    return this.http.request<{ issue: IssueSummary; events: EventSummary[] }>(
      `${P}/issues/${id}`,
    );
  }

  async setIssueStatus(id: string, status: IssueStatus) {
    return this.http.request<{ issue: IssueSummary }>(`${P}/issues/${id}`, {
      method: "PATCH",
      body: { status },
    });
  }

  async deleteIssue(id: string) {
    return this.http.request<void>(`${P}/issues/${id}`, { method: "DELETE" });
  }
}
