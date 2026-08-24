// Test config from env; supplied by `bin/integration-test` (loaded from
// ZeroVault zero-tests/development). Missing vars fail fast.

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing env var: ${name}. Run via 'bin/integration-test' (loads ZeroVault zero-tests/development).`,
    );
  }
  return value;
};

export interface TelegramTestEnv {
  apiId: number;
  apiHash: string;
  session: string;
  chatId: string;
  threadId: number;
  botUsername: string;
}

export const loadTelegramEnv = (): TelegramTestEnv => ({
  apiId: Number(requireEnv("TG_TEST_API_ID")),
  apiHash: requireEnv("TG_TEST_API_HASH"),
  session: requireEnv("TG_TEST_SESSION_STRING"),
  chatId: requireEnv("TG_TEST_CHAT_ID"),
  threadId: Number(requireEnv("TG_TEST_THREAD_ID")),
  botUsername: requireEnv("TG_TEST_BOT_USERNAME"),
});
