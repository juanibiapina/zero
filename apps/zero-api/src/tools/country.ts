import { z } from "zod";
import { defineTool, type AgentToolSet } from "../agents/protocol";
import { isValidCountry } from "../country";
import { log } from "../log";

export interface CountryToolDeps {
  setCountry?: (country: string) => void | Promise<void>;
}

export const buildCountryTool = (deps: CountryToolDeps): AgentToolSet => ({
  set_country: defineTool({
    description:
      "Update the user's country when they tell you where they are or that " +
      "they moved. Pass an ISO 3166-1 alpha-2 country code (e.g. \"PT\", " +
      '"JP", "DE").',
    inputSchema: z.object({
      country: z
        .string()
        .describe('ISO 3166-1 alpha-2 country code, e.g. "PT"'),
    }),
    execute: async ({ country }) => {
      const normalized = country.toUpperCase();
      if (!isValidCountry(normalized)) {
        log("set_country_invalid", { country });
        return {
          error: `"${country}" is not a valid ISO 3166-1 alpha-2 country code.`,
        };
      }
      if (!deps.setCountry) {
        return { error: "Can't change the country in this context." };
      }
      await deps.setCountry(normalized);
      log("set_country", { country: normalized });
      return { ok: true, country: normalized };
    },
  }),
});
