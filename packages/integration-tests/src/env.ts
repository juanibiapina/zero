/**
 * ============================================================================
 * Test Environment
 * ============================================================================
 *
 * All test config comes from environment variables, supplied by the
 * `bin/integration-test` wrapper via `doppler run --project zero-tests
 * --config dev`. Missing vars fail fast with a pointer back to Doppler.
 */

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing env var: ${name}. Run via 'bin/integration-test' or 'doppler run --project zero-tests --config dev -- ...'.`,
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
