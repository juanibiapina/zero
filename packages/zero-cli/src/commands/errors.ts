/**
 * `zero errors` — ZeroErrors reporting and issue management.
 *
 * Data goes to stdout, everything else to stderr, so `--json` output can be
 * piped straight into another tool.
 */

import type { Command } from "commander";
import { getErrorsClient, type AuthFlags } from "../auth.js";
import { ApiError } from "../clients/http.js";
import type { IssueStatus, IssueSummary } from "../clients/errors.js";

function parseStatus(raw: string | undefined): IssueStatus | undefined {
  if (raw === undefined) return undefined;
  if (raw === "open" || raw === "resolved") return raw;
  console.error(`Invalid status: ${raw} (expected open|resolved)`);
  process.exit(1);
}

function printIssue(issue: IssueSummary): void {
  console.log(
    `${issue.id}  ${issue.status}  ${issue.level}  x${issue.count}  ` +
      `${issue.lastSeenAt}  ${issue.title}`,
  );
}

/** Read the whole of stdin, for `--stack -`. */
async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) chunks.push(chunk as string);
  return chunks.join("");
}

/** Turn a 404 from the API into the CLI's own message and exit code. */
async function withNotFound(id: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      console.error(`Issue not found: ${id}`);
      process.exit(1);
    }
    throw err;
  }
}

export function register(program: Command): void {
  const errors = program
    .command("errors")
    .description("Report errors and manage issues in ZeroErrors");

  const client = () => getErrorsClient(program.opts<AuthFlags>());

  errors
    .command("report")
    .requiredOption("-p, --project <name>", "Project name (groups and labels the issue)")
    .requiredOption("-m, --message <text>", "Error message (first line becomes the title)")
    .option("-l, --level <level>", "error|warning|info", "error")
    .option("-s, --stack <text>", "Stack trace, or '-' to read it from stdin")
    .option("-c, --context <json>", "Extra JSON object stored with the event")
    .description("Send an error report")
    .action(
      async (opts: {
        project: string;
        message: string;
        level: string;
        stack?: string;
        context?: string;
      }) => {
        if (opts.level !== "error" && opts.level !== "warning" && opts.level !== "info") {
          console.error(`Invalid level: ${opts.level} (expected error|warning|info)`);
          process.exit(1);
        }

        let context: Record<string, unknown> | undefined;
        if (opts.context) {
          try {
            context = JSON.parse(opts.context) as Record<string, unknown>;
          } catch {
            console.error("Invalid --context: not valid JSON");
            process.exit(1);
          }
        }

        const stack = opts.stack === "-" ? await readStdin() : opts.stack;

        const result = await (await client()).report({
          project: opts.project,
          message: opts.message,
          ...(stack ? { stack } : {}),
          level: opts.level,
          ...(context ? { context } : {}),
        });

        console.log(result.issueId);
        console.error(
          result.isNew ? "Created a new issue" : "Grouped into an existing issue",
        );
      },
    );

  const issues = errors
    .command("issues")
    .description("List, inspect, resolve and delete issues");

  issues
    .command("list")
    .option("-p, --project <name>", "Only this project")
    .option("-s, --status <status>", "open|resolved")
    .option("--json", "Print the raw API response")
    .description("List issues")
    .action(async (opts: { project?: string; status?: string; json?: boolean }) => {
      const status = parseStatus(opts.status);
      const result = await (await client()).listIssues({
        ...(opts.project ? { project: opts.project } : {}),
        ...(status ? { status } : {}),
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.issues.length === 0) {
        console.log("No issues");
        return;
      }
      for (const issue of result.issues) printIssue(issue);
    });

  issues
    .command("get")
    .argument("<id>", "Issue ID")
    .option("--json", "Print the raw API response")
    .description("Show an issue and its recent events")
    .action(async (id: string, opts: { json?: boolean }) => {
      await withNotFound(id, async () => {
        const result = await (await client()).getIssue(id);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printIssue(result.issue);
        console.log(`project: ${result.issue.project}`);
        console.log(`first seen: ${result.issue.firstSeenAt}`);
        for (const event of result.events) {
          console.log(`\n--- ${event.receivedAt}`);
          console.log(event.message);
          if (event.stack) console.log(event.stack);
          if (event.context) console.log(JSON.stringify(event.context, null, 2));
        }
      });
    });

  issues
    .command("resolve")
    .argument("<id>", "Issue ID")
    .description("Mark an issue resolved")
    .action(async (id: string) => {
      await withNotFound(id, async () => {
        await (await client()).setIssueStatus(id, "resolved");
        console.log(`Resolved issue ${id}`);
      });
    });

  issues
    .command("reopen")
    .argument("<id>", "Issue ID")
    .description("Reopen a resolved issue")
    .action(async (id: string) => {
      await withNotFound(id, async () => {
        await (await client()).setIssueStatus(id, "open");
        console.log(`Reopened issue ${id}`);
      });
    });

  issues
    .command("delete")
    .argument("<id>", "Issue ID")
    .description("Delete an issue and its stored events (no undo)")
    .action(async (id: string) => {
      await withNotFound(id, async () => {
        await (await client()).deleteIssue(id);
        console.log(`Deleted issue ${id}`);
      });
    });
}
