// One-shot CLI: walks through phone + SMS-code (+ 2FA) and prints a
// TG_TEST_SESSION_STRING to copy into Doppler.
//
//   pnpm --filter @zero/integration-tests login
//
// Requires TG_TEST_API_ID and TG_TEST_API_HASH (Doppler zero-tests/dev).
// See docs/integration-tests.md.

import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { requireEnv } from "./env.js";

const apiId = Number(requireEnv("TG_TEST_API_ID"));
const apiHash = requireEnv("TG_TEST_API_HASH");

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: async () =>
    await input.text("Phone number (with country code, e.g. +14155551234): "),
  phoneCode: async () => await input.text("Login code from Telegram: "),
  password: async () =>
    await input.password("2FA password (leave empty if none): "),
  onError: (err) => console.error(err),
});

console.log("\n=== TG_TEST_SESSION_STRING (paste into Doppler zero-tests/dev) ===");
console.log(client.session.save());
console.log("===================================================================\n");

await client.disconnect();
