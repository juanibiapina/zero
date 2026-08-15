/**
 * `zero login` / `zero logout` — browser sign-in for a developer machine.
 *
 * The alternative to an API key: the credential this stores belongs to one
 * person on one machine, carries one organization, and can be revoked on its
 * own. Keys stay the right answer for CI and servers, which have no browser.
 */

import { spawn } from "node:child_process";
import type { Command } from "commander";
import {
  addContext,
  contextLogin,
  DEFAULT_BASE_URL,
  isLoginContext,
  loadConfig,
  loginKey,
  resolveContextEntryForDir,
  resolveContextForDir,
  saveConfig,
} from "../config.js";
import { runLoginFlow } from "../login-flow.js";
import { DEFAULT_CLIENT_ID, DEFAULT_ISSUER, revokeLogin } from "../oauth.js";

interface LoginFlags {
  baseUrl?: string;
  port?: string;
  context?: string;
}

/** The API origin a login authorizes: flag > context > env > default. */
function resolveBaseUrl(flags: { baseUrl?: string }): string {
  const context = resolveContextForDir(loadConfig(), process.cwd());
  return flags.baseUrl ?? context?.baseUrl ?? process.env.ZERO_API_URL ?? DEFAULT_BASE_URL;
}

/**
 * Opens the system browser, and never fails the login when it cannot: the URL
 * is printed either way, which is the only thing that works over SSH.
 */
function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Headless box. The printed URL is the fallback.
  }
  return Promise.resolve();
}

export function register(program: Command): void {
  program
    .command("login")
    .description("Sign in with a browser (no API key needed)")
    .option("--port <port>", "fixed callback port (for `ssh -L` forwarding)")
    .option(
      "--context <name>",
      "store this sign-in as a named context instead of the machine default, " +
        "so `zero context use <name>` can bind a directory to its organization",
    )
    .action(async (flags: LoginFlags) => {
      const baseUrl = resolveBaseUrl({
        baseUrl: program.opts<{ baseUrl?: string }>().baseUrl ?? flags.baseUrl,
      });
      const port = flags.port ? Number(flags.port) : 0;
      if (flags.port && !Number.isInteger(port)) {
        console.error(`Error: --port must be a number, got ${flags.port}`);
        process.exit(1);
      }

      let login;
      try {
        login = await runLoginFlow({
          issuer: DEFAULT_ISSUER,
          clientId: DEFAULT_CLIENT_ID,
          port,
          openBrowser: async (url) => {
            console.error("Opening your browser to sign in. If it does not open, visit:");
            console.error(url);
            await openBrowser(url);
          },
        });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        console.error(
          "On a machine with no browser, forward the port " +
            "(`ssh -L 8976:127.0.0.1:8976 …` then `zero login --port 8976`), " +
            "or use an API key: export ZERO_API_KEY=…",
        );
        process.exit(1);
      }

      if (!login.orgId) {
        console.error(
          "Error: that sign-in carries no organization, so it cannot reach any " +
            "vault. Run `zero login` again and pick an organization on the " +
            "consent screen.",
        );
        process.exit(1);
      }

      const config = loadConfig();

      if (!flags.context) {
        config.logins = { ...config.logins, [baseUrl]: login };
        saveConfig(config);
        console.log(`Signed in as ${login.email ?? login.userId} (org ${login.orgId}).`);
        return;
      }

      // The consent screen hands out the session's active organization, so a
      // second sign-in can silently repeat the first one. Say so: the whole
      // point of a named context is that it carries a different org.
      const machineLogin = config.logins?.[baseUrl];
      if (machineLogin?.orgId === login.orgId) {
        console.error(
          `Warning: that sign-in carries org ${login.orgId}, the same org as ` +
            "your default sign-in. Switch the active organization at " +
            "https://dash.zeroapps.dev and run the command again.",
        );
      }

      config.logins = { ...config.logins, [loginKey(baseUrl, login.orgId)]: login };
      saveConfig(
        addContext(config, flags.context, {
          login: { orgId: login.orgId },
          ...(baseUrl !== DEFAULT_BASE_URL ? { baseUrl } : {}),
        }),
      );

      console.log(`Signed in as ${login.email ?? login.userId} (org ${login.orgId}).`);
      console.log(`Added context: ${flags.context}`);
      console.log(`Run \`zero context use ${flags.context}\` in the project directory.`);
    });

  program
    .command("logout")
    .description("Revoke the sign-in this directory uses (or this machine's)")
    .action(async () => {
      const baseUrl = resolveBaseUrl(program.opts<{ baseUrl?: string }>());
      const config = loadConfig();

      // In a directory bound to a sign-in, that is the credential the user has
      // been running with, so it is the one `logout` must end.
      const entry = resolveContextEntryForDir(config, process.cwd());
      const bound =
        entry && isLoginContext(entry.context)
          ? contextLogin({ context: entry.context, baseUrl, logins: config.logins })
          : null;
      const key = bound?.key ?? baseUrl;
      const login = bound ? bound.login : config.logins?.[baseUrl];

      if (!login) {
        console.error(`Not signed in to ${baseUrl}.`);
        process.exit(1);
      }

      await revokeLogin(login);
      delete config.logins?.[key];
      saveConfig(config);

      console.log(
        bound
          ? `Signed out of ${baseUrl} (context ${entry!.name}, org ${login.orgId}).`
          : `Signed out of ${baseUrl}.`,
      );
    });
}
