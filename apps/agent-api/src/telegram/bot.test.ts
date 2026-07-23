/// <reference types="node" />
// Bug-fix proof for the createBot factory: the factory-built bot must honor
// TELEGRAM_API_ROOT. Unlike the grammy-mock unit tests, this file uses a REAL
// grammY client (grammy is NOT mocked here) against a local node:http listener,
// so it can prove the configured API root is respected. chat-action.ts
// previously dropped client.apiRoot, so its bot routed to the default
// api.telegram.org and never reached a configured root. grammY uses its own
// node fetch shim (not globalThis.fetch), so a real listener is required.
//
// The node "types" reference above is scoped to this file only; worker source
// stays node-free (tsconfig `types` pins worker-configuration.d.ts).

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createBot } from "./bot";
import type { Env } from "../types";

const startListener = (
  hits: string[],
): Promise<{ server: Server; origin: string }> =>
  new Promise((resolve) => {
    const server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        hits.push(req.url ?? "");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: true }));
      },
    );
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        // No trailing slash: grammY throws when apiRoot ends in "/".
        resolve({ server, origin: `http://127.0.0.1:${addr.port}` });
      }
    });
  });

let openServer: Server | undefined;

afterEach(() => {
  openServer?.close();
  openServer = undefined;
});

describe("createBot", () => {
  it("routes bot.api calls to TELEGRAM_API_ROOT (honors apiRoot)", async () => {
    const hits: string[] = [];
    const { server, origin } = await startListener(hits);
    openServer = server;

    const env = {
      TELEGRAM_BOT_TOKEN: "TESTTOKEN",
      TELEGRAM_BOT_INFO: JSON.stringify({
        id: 1,
        is_bot: true,
        first_name: "bot",
        username: "bot",
      }),
      TELEGRAM_API_ROOT: origin,
    } as unknown as Env;

    const bot = createBot(env);
    await bot.api.sendChatAction(100, "typing");

    // Exactly one request, at the configured root, and no getMe.
    expect(hits).toEqual(["/botTESTTOKEN/sendChatAction"]);
  });
});
