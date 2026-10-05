/**
 * LogNotifier — the only adapter shipped now.
 *
 * console.log the issue. Visible via `wrangler tail` / `bin/cflogs`. Zero
 * config; proves the trigger logic end to end without committing to a channel.
 */

import type { IssueSummary } from "@zero/errors-core";
import type { Notifier, NotifyKind } from "./notifier";

export class LogNotifier implements Notifier {
  async notify(issue: IssueSummary, kind: NotifyKind): Promise<void> {
    console.log({
      event: kind === "new" ? "errors.issue_new" : "errors.issue_regression",
      issueId: issue.id,
      project: issue.project,
      title: issue.title,
      level: issue.level,
      count: issue.count,
    });
  }
}
