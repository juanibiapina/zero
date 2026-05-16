// Owns the topic↔session linkage in KV. A session is a pair of mirrored
// entries that must be created and deleted together:
//
//   topic:{clerkUserId}:{chatId}:{messageThreadId} → sessionId
//   session:{sessionId}                            → SessionRecord JSON
//
// Both directions are stored explicitly because KV has no reverse lookup.

import { z } from "zod";
import type { Env } from "./types";

// Stored under `session:{sessionId}`. A session's identity *is* its topic
// coordinates.
export const SessionRecordSchema = z.object({
  clerkUserId: z.string(),
  chatId: z.number(),
  messageThreadId: z.number(),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

const topicKey = (record: SessionRecord) =>
  `topic:${record.clerkUserId}:${record.chatId.toString()}:${record.messageThreadId.toString()}`;

const sessionKey = (sessionId: string) => `session:${sessionId}`;

/** Resolve the sessionId for this topic, or null if no session exists yet. */
export const lookupSessionId = (
  env: Env,
  record: SessionRecord,
): Promise<string | null> => env.KV.get(topicKey(record));

/**
 * Resolve a sessionId to its Telegram coordinates, or null if unknown.
 * Throws on schema-validation failure so callers can distinguish a
 * corrupt record from absence.
 */
export const lookupSessionRecord = async (
  env: Env,
  sessionId: string,
): Promise<SessionRecord | null> => {
  const raw = await env.KV.get(sessionKey(sessionId));
  if (!raw) return null;
  return SessionRecordSchema.parse(JSON.parse(raw));
};

/** Persist a new session by writing both KV directions. */
export const recordSession = async (
  env: Env,
  sessionId: string,
  record: SessionRecord,
): Promise<void> => {
  await env.KV.put(topicKey(record), sessionId);
  await env.KV.put(sessionKey(sessionId), JSON.stringify(record));
};

/**
 * Delete both KV entries. On corrupt/missing record the `session:` key is
 * still deleted; any lingering `topic:` key gets overwritten by the next
 * session created in that topic.
 */
export const forgetSession = async (
  env: Env,
  sessionId: string,
): Promise<void> => {
  let record: SessionRecord | null = null;
  try {
    record = await lookupSessionRecord(env, sessionId);
  } catch {
    // best-effort cleanup
  }
  await env.KV.delete(sessionKey(sessionId));
  if (record) {
    await env.KV.delete(topicKey(record));
  }
};
