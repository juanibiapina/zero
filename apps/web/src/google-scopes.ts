/**
 * Google Workspace scopes requested by the "Connect Google" flow.
 *
 * Kept in one place so the frontend asks for exactly what the
 * agent-container `gws` CLI will need. All four are requested as a
 * single block — there is no per-service granularity today.
 */
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
] as const;

/**
 * Return the entries from `required` that are NOT present in the
 * space-separated `approved` scope string Clerk stores on an
 * `ExternalAccountResource`. Pure helper — keeps the React component
 * free of string-splitting.
 */
export const missingScopes = (
  approved: string,
  required: readonly string[],
): string[] => {
  const approvedSet = new Set(approved.split(/\s+/).filter(Boolean));
  return required.filter((scope) => !approvedSet.has(scope));
};
