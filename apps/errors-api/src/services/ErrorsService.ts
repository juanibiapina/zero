/**
 * ============================================================================
 * ErrorsService — Ingest orchestration
 * ============================================================================
 *
 * The Services layer: validates-in, computes the fingerprint (pure core fn),
 * records via the DO, and decides *when* to notify. The Notifier port decides
 * *how*. Notification is fired through the injected `waitUntil` so it never
 * blocks the response and never fails the request.
 */

import { fingerprint, type ErrorReport, type IngestResponse } from "@zero/errors-core";
import type { ErrorsDO } from "../ErrorsDO";
import type { Notifier } from "../notify/notifier";

type ErrorsStub = DurableObjectStub<ErrorsDO>;
type WaitUntil = (p: Promise<unknown>) => void;

export class ErrorsService {
  constructor(
    private readonly errors: ErrorsStub,
    private readonly notifier: Notifier,
  ) {}

  async report(
    report: ErrorReport,
    userId: string,
    waitUntil: WaitUntil,
  ): Promise<IngestResponse> {
    const fp = await fingerprint({
      project: report.project,
      message: report.message,
      stack: report.stack,
    });

    const { issue, isNew, isRegression } = await this.errors.record({
      fingerprint: fp,
      project: report.project,
      title: titleOf(report.message),
      level: report.level ?? "error",
      message: report.message,
      stack: report.stack ?? null,
      contextJson: report.context ? JSON.stringify(report.context) : null,
      userId,
      now: new Date().toISOString(),
    });

    if (isNew || isRegression) {
      const kind = isNew ? "new" : "regression";
      // Fire-and-forget: swallow errors so a notify failure never fails ingest.
      waitUntil(this.notifier.notify(issue, kind).catch(() => {}));
    }

    return { issueId: issue.id, isNew };
  }
}

/** The issue title is the first line of the message, trimmed and capped. */
function titleOf(message: string): string {
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  return firstLine.slice(0, 200);
}
