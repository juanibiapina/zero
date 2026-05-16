/**
 * ============================================================================
 * Session linkage
 * ============================================================================
 *
 * Owns the topic↔session linkage in KV. A "session" lives as a pair of
 * mirrored entries that must always be created together and deleted
 * together:
 *
 *   topic:{clerkUserId}:{chatId}:{messageThreadId} → sessionId
 *   session:{sessionId}                            → { clerkUserId, chatId, messageThreadId }
 *
 * The webhook resolves topic → sessionId for inbound messages; the
 * container's outbound reply handler resolves sessionId → topic to know
 * which Telegram thread to post into. KV doesn't support reverse lookup,
 * so both directions are stored explicitly.
 *
 * All callers — `routes/telegram-webhook.ts` and `AgentContainer.ts` —
 * go through this module so the key formats, the record schema, and
 * the pair-as-unit invariant live in one place.
 */

import { z } from "zod";
import type { Env } from "./types";

// ── Schema ──────────────────────────────────────────────────────────────

/**
 * The data stored under `session:{sessionId}`. Also defines the topic
 * coordinates: a session's identity *is* its topic coordinates.
 */
export const SessionRecordSchema = z.object({
  clerkUserId: z.string(),
  chatId: z.number(),
  messageThreadId: z.number(),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

// ── Keys (private) ──────────────────────────────────────────────────────

const topicKey = (record: SessionRecord) =>
  `topic:${record.clerkUserId}:${record.chatId.toString()}:${record.messageThreadId.toString()}`;

const sessionKey = (sessionId: string) => `session:${sessionId}`;

// ── Operations ──────────────────────────────────────────────────────────

/** Resolve the sessionId for this topic, or null if no session exists yet. */
export const lookupSessionId = (
  env: Env,
  record: SessionRecord,
): Promise<string | null> => env.KV.get(topicKey(record));

/**
 * Resolve a sessionId back to the Telegram coordinates it was created
 * for. Returns null if the session is unknown. Throws if the stored
 * record fails schema validation — callers that need to distinguish
 * corruption from absence should catch the throw.
 */
export const lookupSessionRecord = async (
  env: Env,
  sessionId: string,
): Promise<SessionRecord | null> => {
  const raw = await env.KV.get(sessionKey(sessionId));
  if (!raw) return null;
  return SessionRecordSchema.parse(JSON.parse(raw));
};

/**
 * Persist a new session. Writes both KV directions; the pair is what
 * downstream readers rely on.
 */
export const recordSession = async (
  env: Env,
  sessionId: string,
  record: SessionRecord,
): Promise<void> => {
  await env.KV.put(topicKey(record), sessionId);
  await env.KV.put(sessionKey(sessionId), JSON.stringify(record));
};

/**
 * Delete both KV entries for a session. Reads the record first to find
 * the topic coordinates; if the record is missing or corrupt, the
 * `session:` key is still deleted (best-effort cleanup — the `topic:`
 * key for a corrupt record may linger, but it will be overwritten on the
 * next inbound message in that topic).
 */
export const forgetSession = async (
  env: Env,
  sessionId: string,
): Promise<void> => {
  let record: SessionRecord | null = null;
  try {
    record = await lookupSessionRecord(env, sessionId);
  } catch {
    // Corrupt record — drop the session: key anyway; the topic: key
    // will be overwritten by the next session created in this topic.
  }
  await env.KV.delete(sessionKey(sessionId));
  if (record) {
    await env.KV.delete(topicKey(record));
  }
};
