// Google Workspace scopes requested by the "Connect Google" flow.
// Requested as one block.
//
// Each scope is the narrowest one that covers the tools in
// `apps/agent-api/src/google/rest.ts`, because OAuth verification asks
// why a narrower scope would not do:
//   - gmail.modify           read, compose and send (gmail_search/thread/send)
//   - calendar.events        events.list and events.insert
//   - calendar.calendarlist.readonly
//                            calendarList.list, which calendar.events alone
//                            does NOT grant (per the Calendar v3 discovery doc)
//   - drive                  full read/write Drive access
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/drive",
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
