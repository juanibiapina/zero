/**
 * ============================================================================
 * API Client
 * ============================================================================
 *
 * Typed fetch client for the /api/* dashboard endpoints, using the shared
 * fetchApi wrapper (attaches the Clerk JWT).
 */

import { fetchApi, type GetToken } from "@zero/ui";
import type {
  IssueListResponse,
  IssueDetailResponse,
  IssueSummary,
  IssueStatus,
} from "@zero/errors-core";

export async function listIssues(
  getToken: GetToken,
  project?: string,
  status?: IssueStatus,
): Promise<IssueListResponse> {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (status) params.set("status", status);
  const qs = params.toString();
  return fetchApi<IssueListResponse>(
    `/api/errors/issues${qs ? `?${qs}` : ""}`,
    getToken,
  );
}

export async function getIssue(
  getToken: GetToken,
  id: string,
): Promise<IssueDetailResponse> {
  return fetchApi<IssueDetailResponse>(`/api/errors/issues/${id}`, getToken);
}

export async function deleteIssue(
  getToken: GetToken,
  id: string,
): Promise<void> {
  return fetchApi<void>(`/api/errors/issues/${id}`, getToken, {
    method: "DELETE",
  });
}

export async function setIssueStatus(
  getToken: GetToken,
  id: string,
  status: IssueStatus,
): Promise<{ issue: IssueSummary }> {
  return fetchApi<{ issue: IssueSummary }>(`/api/errors/issues/${id}`, getToken, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}
