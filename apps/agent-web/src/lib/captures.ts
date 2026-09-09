// Same-origin requests: the browser carries the Clerk session cookie, so no
// Bearer token is needed here (unlike the cross-origin mobile client).

import type { Capture } from "@zero/agent-core";

export type { Capture };

export async function fetchCaptures(): Promise<Capture[]> {
  const res = await fetch("/api/captures");
  if (!res.ok) {
    throw new Error(`GET /api/captures failed: ${res.status}`);
  }
  const body = (await res.json()) as { captures: Capture[] };
  return body.captures;
}

export async function addCapture(capture: {
  id: string;
  text: string;
}): Promise<Capture> {
  const res = await fetch("/api/captures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(capture),
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

export async function unprocessCapture(id: string): Promise<Capture> {
  const res = await fetch(`/api/captures/${id}/unprocess`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`POST /api/captures/${id}/unprocess failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}

export async function editCapture(id: string, text: string): Promise<Capture> {
  const res = await fetch(`/api/captures/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/captures/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}

export async function rescheduleCapture(
  id: string,
  showUpDate: string | null,
): Promise<Capture> {
  const res = await fetch(`/api/captures/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ showUpDate }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/captures/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}

export async function reorderCapture(
  id: string,
  sortKey: string,
): Promise<Capture> {
  const res = await fetch(`/api/captures/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sortKey }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/captures/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}
