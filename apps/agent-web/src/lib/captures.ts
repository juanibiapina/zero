// Same-origin requests: the browser carries the Clerk session cookie, so no
// Bearer token is needed here (unlike the cross-origin mobile client).

export type Capture = {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
};

export async function fetchInbox(): Promise<Capture[]> {
  const res = await fetch("/api/captures");
  if (!res.ok) {
    throw new Error(`GET /api/captures failed: ${res.status}`);
  }
  const body = (await res.json()) as { captures: Capture[] };
  return body.captures;
}

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

export async function processCapture(id: string): Promise<Capture> {
  const res = await fetch(`/api/captures/${id}/process`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`POST /api/captures/${id}/process failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}
