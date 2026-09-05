// Same-origin requests: the browser carries the Clerk session cookie.

import type { WaitingCondition, WaitingConditionKind } from "@zero/agent-core";

export type { WaitingCondition };

export async function fetchWaits(): Promise<WaitingCondition[]> {
  const res = await fetch("/api/waits");
  if (!res.ok) throw new Error(`GET /api/waits failed: ${res.status}`);
  const body = (await res.json()) as { conditions: WaitingCondition[] };
  return body.conditions;
}

export async function addWaitingCondition(condition: {
  id: string;
  projectId: string;
  kind: WaitingConditionKind;
  text: string | null;
  refId: string | null;
  targetStatus: string | null;
}): Promise<WaitingCondition> {
  const res = await fetch("/api/waits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(condition),
  });
  if (!res.ok) throw new Error(`POST /api/waits failed: ${res.status}`);
  const body = (await res.json()) as { condition: WaitingCondition };
  return body.condition;
}

export async function resolveWaitingCondition(
  id: string,
): Promise<WaitingCondition> {
  const res = await fetch(`/api/waits/${id}/resolve`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`POST /api/waits/${id}/resolve failed: ${res.status}`);
  }
  const body = (await res.json()) as { condition: WaitingCondition };
  return body.condition;
}

export async function deleteWaitingCondition(id: string): Promise<void> {
  const res = await fetch(`/api/waits/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /api/waits/${id} failed: ${res.status}`);
}
