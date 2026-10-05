// Alarm turn-draining with safe, unbounded self-reschedule.
//
// UserDO.alarm() drains every conversation that still owes work. A catchable failure
// (LLM gateway error, network abort) must not permanently drop the reply, but
// we also must never spin a paid alarm loop. This module encapsulates that
// trade-off so it can be tested without a Durable Object.
//
// Contract (verified against CF docs):
//   - On failure we self-reschedule ONLY while findConversationsWithWork() still
//     returns work. That guard is the circuit breaker: once every conversation
//     has an empty queue and a finished assistant response, nothing reschedules.
//   - We catch and RETURN (never rethrow). Rethrowing breaks the DO output gate
//     and discards our setAlarm write, falling back to CF's built-in retry
//     which is capped at 6. Catch+return makes retries effectively unbounded.
//   - Backoff grows via a storage-backed attempt counter, NOT
//     alarmInfo.retryCount, which resets to 0 on the catch+return path.
//
// Scope: this only rescues catchable thrown errors. A DO isolate reset
// ("code was updated") tears down the isolate before catch runs; that path
// relies on CF's built-in at-least-once retry plus the next user message
// re-arming the alarm.

import { log, logError, fmtErr } from "../log";
import type { Thread } from "../store/types";

export const ATTEMPTS_KEY = "alarmAttempts";
export const BASE_BACKOFF_MS = 2000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

// Exponential backoff from the storage-backed attempt counter, capped.
export const backoffMs = (attempts: number): number =>
  Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);

// The subset of DurableObjectStorage this module needs. ctx.storage satisfies it.
export interface AlarmStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface AlarmTurnsDeps {
  storage: AlarmStorage;
  findConversationsWithWork: () => Thread[];
  runTurn: (chatId: number, topicId: number) => Promise<void>;
  now?: () => number;
  // Optional exception sink (ZeroErrors). Best-effort and must never reject;
  // awaited so it completes within the alarm's lifetime.
  reportError?: (err: unknown) => Promise<void>;
}

export const runAlarmTurns = async (deps: AlarmTurnsDeps): Promise<void> => {
  const { storage, findConversationsWithWork, runTurn } = deps;
  const now = deps.now ?? Date.now;

  const startedAt = now();
  let turns = 0;

  try {
    for (const thread of findConversationsWithWork()) {
      await runTurn(thread.chatId, thread.topicId);
      turns++;
    }
    // Drained cleanly: reset the backoff counter.
    await storage.delete(ATTEMPTS_KEY);
    // The handler returned. Cloudflare kills an alarm invocation at a 900s
    // wall-time ceiling with `outcome: exceededWallTime`, which is not an
    // exception and so never reaches the catch below — a stalled drain is
    // visible only as this line never being written. Pair it with the Workers
    // Logs `invocations` view (outcome / wallTimeMs / cpuTimeMs) when
    // investigating.
    log("alarm_finished", { turns, duration_ms: now() - startedAt });
  } catch (err) {
    logError("alarm_turn_failed", { error: fmtErr(err) });
    await deps.reportError?.(err);

    // Circuit breaker: only reschedule while work remains. Prevents a runaway
    // paid alarm loop once every thread has been answered.
    if (findConversationsWithWork().length === 0) {
      await storage.delete(ATTEMPTS_KEY);
      return;
    }

    const attempts = ((await storage.get<number>(ATTEMPTS_KEY)) ?? 0) + 1;
    await storage.put(ATTEMPTS_KEY, attempts);
    await storage.setAlarm(now() + backoffMs(attempts));
    // Return normally so the setAlarm write survives the output gate.
  }
};
