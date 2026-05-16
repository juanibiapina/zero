// Google Workspace scopes requested by the "Connect Google" flow.
// Requested as one block; matches what the container's `gws` CLI needs.
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
] as const;

// Return entries from `required` missing from the space-separated
// `approved` string Clerk stores on an ExternalAccountResource.
export const missingScopes = (
  approved: string,
  required: readonly string[],
): string[] => {
  const approvedSet = new Set(approved.split(/\s+/).filter(Boolean));
  return required.filter((scope) => !approvedSet.has(scope));
};
