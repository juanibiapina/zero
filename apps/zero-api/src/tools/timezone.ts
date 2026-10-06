// set_timezone tool for the interface agent. The web app keeps the stored zone
// fresh whenever the user opens it, but a user who travels and only uses
// Telegram can't be auto-detected (the Bot API carries no timezone). This lets
// the agent update the zone when the user says where they are ("I'm in Tokyo
// now"). The model supplies the IANA name; the tool validates it and offers
// near matches on a miss so the model can correct itself.

import { defineTool, type AgentToolSet } from "../agents/protocol";
import { z } from "zod";
import { log } from "../log";
import { isValidTimezone, suggestTimezones } from "../timezone";

export interface TimezoneToolDeps {
  // Persist the new zone. Omitted in contexts without user settings (tests);
  // the tool then reports it can't change the timezone rather than lying.
  setTimezone?: (tz: string) => void | Promise<void>;
}

export const buildTimezoneTool = (deps: TimezoneToolDeps): AgentToolSet => {
  const { setTimezone } = deps;

  return {
    set_timezone: defineTool({
      description:
        "Update the user's timezone when they tell you where they are or that " +
        "their timezone changed. Pass a canonical IANA zone name (e.g. " +
        '"Asia/Tokyo", "America/Sao_Paulo", "Europe/Berlin").',
      inputSchema: z.object({
        timezone: z
          .string()
          .describe('IANA timezone name, e.g. "Europe/Berlin"'),
      }),
      execute: async ({ timezone }) => {
        if (!isValidTimezone(timezone)) {
          const suggestions = suggestTimezones(timezone);
          log("set_timezone_invalid", { timezone });
          return {
            error: `"${timezone}" is not a valid IANA timezone.`,
            suggestions,
          };
        }
        if (!setTimezone) {
          return { error: "Can't change the timezone in this context." };
        }
        await setTimezone(timezone);
        log("set_timezone", { timezone });
        return { ok: true, timezone };
      },
    }),
  };
};
