// One-shot CLI: walks through phone + SMS-code (+ 2FA) and prints a
// TG_TEST_SESSION_STRING to copy into ZeroVault.
//
//   pnpm --filter @zero/integration-tests login
//
// Requires TG_TEST_API_ID and TG_TEST_API_HASH (ZeroVault zero-tests/development).
// See docs/integration-tests.md.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { requireEnv } from "./env.js";

const apiId = Number(requireEnv("TG_TEST_API_ID"));
const apiHash = requireEnv("TG_TEST_API_HASH");

const rl = createInterface({ input: stdin, output: stdout });

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: async () =>
    await rl.question("Phone number (with country code, e.g. +14155551234): "),
  phoneCode: async () => await rl.question("Login code from Telegram: "),
  password: async () => await rl.question("2FA password (leave empty if none): "),
  onError: (err) => console.error(err),
});

rl.close();

console.log("\n=== TG_TEST_SESSION_STRING (paste into ZeroVault zero-tests/development) ===");
console.log(client.session.save());
console.log("===================================================================\n");

await client.disconnect();
