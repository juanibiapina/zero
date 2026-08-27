// The GTD capture Inbox, consumed from the web app. Same-origin requests: the
// browser carries the Clerk session cookie, which clerkMiddleware on the worker
// reads to authenticate, so no Bearer token is needed here (unlike mobile, which
// is cross-origin). Both surfaces hit the same per-user UserDO, so the web and
// the phone show the same Inbox.

export type Capture = {
  id: string;
  text: string;
  createdAt: string;
  // Null while in the Inbox; an ISO timestamp once Processed (GTD Clarify).
  processedAt: string | null;
};

// The caller's Inbox (open captures), oldest first.
export async function fetchInbox(): Promise<Capture[]> {
  const res = await fetch("/api/captures");
  if (!res.ok) {
    throw new Error(`GET /api/captures failed: ${res.status}`);
  }
  const body = (await res.json()) as { captures: Capture[] };
  return body.captures;
}

// Capture a new item; returns the created row (with its server id).
export async function addCapture(text: string): Promise<Capture> {
  const res = await fetch("/api/captures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/captures failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}

// Process a capture (GTD Clarify); returns the updated row. The Inbox excludes
// it after.
export async function processCapture(id: string): Promise<Capture> {
  const res = await fetch(`/api/captures/${id}/process`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`POST /api/captures/${id}/process failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}
