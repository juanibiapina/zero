// Thin client for the WebUI chat routes (see apps/api/src/routes/sessions.ts).

export type SessionSummary = {
  sessionId: string;
  type: string;
  name: string | null;
  status: string;
  updatedAt: string | null;
};

export type ChatMessage = {
  id: number;
  role: string;
  text: string;
  createdAt: string;
};

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`Failed to load sessions: ${res.status}`);
  const data = (await res.json()) as { sessions: SessionSummary[] };
  return data.sessions;
}

export async function createSession(name?: string): Promise<string> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name ? { name } : {}),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}

// Returns the session id the message landed on. On a rare stale session the
// server mints a fresh one and returns its id, so the caller navigates there.
export async function sendMessage(sessionId: string, text: string): Promise<string> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Failed to send message: ${res.status}`);
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}

export async function pollMessages(
  sessionId: string,
  since?: number,
): Promise<{ messages: ChatMessage[]; status: string | null }> {
  const url = since !== undefined
    ? `/api/sessions/${sessionId}/messages?since=${since}`
    : `/api/sessions/${sessionId}/messages`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load messages: ${res.status}`);
  return (await res.json()) as { messages: ChatMessage[]; status: string | null };
}
