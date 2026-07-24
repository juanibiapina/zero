/**
 * ============================================================================
 * Notifier Port
 * ============================================================================
 *
 * The channel a notification goes out on is deferred. This port keeps that
 * choice a one-file change: the service decides *when* to notify, an adapter
 * decides *how*. Ship exactly one adapter (LogNotifier) until a channel is
 * chosen. Do not add Telegram/email until then.
 */

import type { IssueSummary } from "@zero/errors-core";

export type NotifyKind = "new" | "regression";

export interface Notifier {
  notify(issue: IssueSummary, kind: NotifyKind): Promise<void>;
}
