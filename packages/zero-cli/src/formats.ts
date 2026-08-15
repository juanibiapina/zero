/**
 * Rendering of a secret set into the formats other tools read.
 *
 * The `env` renderer is the load-bearing one: its output is parsed back by
 * wrangler's dotenv parser (`.dev.vars`, `.env`) and by Vite. That parser
 * strips surrounding quotes and unescapes only `\n` and `\r` inside double
 * quotes, so a multiline value (`GITHUB_APP_PRIVATE_KEY`) must be emitted as a
 * single quoted line with those two escapes, and everything else must stay raw
 * so that JSON values like {"id":1} survive untouched.
 *
 * This rule used to live in the repo script bin/json-to-dotenv.mjs, which
 * existed only because `secrets download --format env` got it wrong.
 */

export type SecretFormat = "env" | "json" | "yaml" | "shell";

export interface Secret {
  key: string;
  value: string;
}

export const SECRET_FORMATS: SecretFormat[] = ["env", "json", "yaml", "shell"];

export function isSecretFormat(value: string): value is SecretFormat {
  return (SECRET_FORMATS as string[]).includes(value);
}

/** Sorted by key, so output is stable across calls and diffable. */
function sortByKey(secrets: Secret[]): Secret[] {
  return [...secrets].sort((a, b) => a.key.localeCompare(b.key));
}

/** One `KEY=VALUE` line per secret, multiline values quoted and escaped. */
export function formatEnv(secrets: Secret[]): string {
  return sortByKey(secrets)
    .map(({ key, value }) => {
      if (/[\r\n]/.test(value)) {
        const escaped = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        return `${key}="${escaped}"`;
      }
      return `${key}=${value}`;
    })
    .join("\n");
}

export function formatSecrets(secrets: Secret[], format: SecretFormat): string {
  const sorted = sortByKey(secrets);

  switch (format) {
    case "json":
      return JSON.stringify(
        Object.fromEntries(sorted.map((s) => [s.key, s.value])),
        null,
        2,
      );
    case "yaml":
      return sorted
        .map((s) => `${s.key}: "${s.value.replace(/"/g, '\\"')}"`)
        .join("\n");
    case "shell":
      return sorted
        .map((s) => `export ${s.key}="${s.value.replace(/"/g, '\\"')}"`)
        .join("\n");
    case "env":
    default:
      return formatEnv(sorted);
  }
}
