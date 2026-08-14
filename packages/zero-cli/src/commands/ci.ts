/**
 * `zero ci trust …` — which GitHub repositories may authenticate as this org
 * without a key.
 *
 * Trust is stored against GitHub's numeric owner and repository ids, so a
 * rename keeps working and a recycled name inherits nothing. The CLI resolves
 * `owner/repo` to those ids through GitHub's API; that call is unauthenticated
 * and therefore only works for public repositories, so `--owner-id`/`--repo-id`
 * exist for the private case (a failing exchange also prints them).
 */

import type { Command } from "commander";
import { getVaultClient, type AuthFlags } from "../auth.js";

interface TrustFlags {
  repo?: string;
  ownerId?: string;
  repoId?: string;
  ref?: string;
  environment?: string;
  allowEvent?: string[];
  label?: string;
}

async function resolveRepoIds(
  repo: string,
  flags: TrustFlags,
): Promise<{ ownerId: string; repoId: string }> {
  if (flags.ownerId && flags.repoId) {
    return { ownerId: flags.ownerId, repoId: flags.repoId };
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    throw new Error(
      `Could not read ${repo} from GitHub (HTTP ${response.status}). ` +
        "Private repositories need GITHUB_TOKEN set, or pass --owner-id and --repo-id.",
    );
  }

  const body = (await response.json()) as { id?: number; owner?: { id?: number } };
  if (!body.id || !body.owner?.id) {
    throw new Error(`GitHub returned no ids for ${repo}.`);
  }

  return { ownerId: String(body.owner.id), repoId: String(body.id) };
}

export function register(program: Command): void {
  const ci = program.command("ci").description("Let CI authenticate without an API key");

  const trust = ci.command("trust").description("Manage trusted CI workloads");

  trust
    .command("add")
    .description("Trust a GitHub repository's workflows")
    .requiredOption("--repo <owner/repo>", "GitHub repository")
    .option("--owner-id <id>", "GitHub owner id (skips the API lookup)")
    .option("--repo-id <id>", "GitHub repository id (skips the API lookup)")
    .option("--ref <ref>", "only this git ref, e.g. refs/heads/main")
    .option("--environment <name>", "only jobs using this environment")
    .option(
      "--allow-event <name>",
      "allow a risky event (pull_request, pull_request_target, workflow_run); repeatable",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--label <name>", "label for the trust record")
    .action(async (flags: TrustFlags) => {
      const client = await getVaultClient(program.opts<AuthFlags>());
      const { ownerId, repoId } = await resolveRepoIds(flags.repo!, flags);

      const result = await client.addCiTrust({
        ownerId,
        repoId,
        repository: flags.repo!,
        ...(flags.ref && { ref: flags.ref }),
        ...(flags.environment && { environment: flags.environment }),
        ...(flags.allowEvent && { allowedEvents: flags.allowEvent }),
        ...(flags.label && { label: flags.label }),
      });

      console.log(`Trusted ${flags.repo!} (id ${result.id}).`);
      console.error(
        "Add `permissions: id-token: write` to the job; no ZERO_API_KEY is needed.",
      );
    });

  trust
    .command("list")
    .description("List trusted CI workloads")
    .action(async () => {
      const client = await getVaultClient(program.opts<AuthFlags>());
      const { trusts } = await client.listCiTrusts();

      if (trusts.length === 0) {
        console.error("No trusted repositories.");
        return;
      }

      for (const t of trusts) {
        const limits = [
          t.ref ? `ref=${t.ref}` : null,
          t.environment ? `env=${t.environment}` : null,
          t.allowedEvents.length > 0 ? `events=${t.allowedEvents.join("|")}` : null,
          t.label ? `(${t.label})` : null,
        ]
          .filter(Boolean)
          .join(" ");
        console.log(`${t.id}: ${t.repository}  ${limits}`.trimEnd());
      }
    });

  trust
    .command("rm <id>")
    .description("Stop trusting a CI workload")
    .action(async (id: string) => {
      const client = await getVaultClient(program.opts<AuthFlags>());
      await client.removeCiTrust(id);
      console.log(`Removed trust ${id}.`);
    });
}
