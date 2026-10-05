// Test-only in-memory stand-in for the TELEGRAM_ACCOUNT_DO namespace, so tests
// that build a bare `env` can exercise the identity module without a Durable
// Object. Records every call, which is how the hot-path guarantee (a KV hit
// never consults the account record) is asserted.

export type FakeAccountCall = [telegramId: string, method: string];

export const fakeAccountNamespace = (owners: Record<string, string> = {}) => {
  const state = new Map(Object.entries(owners));
  const calls: FakeAccountCall[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      owner: async () => {
        calls.push([name, "owner"]);
        return state.get(name) ?? null;
      },
      claim: async (clerkUserId: string) => {
        calls.push([name, "claim"]);
        state.set(name, clerkUserId);
      },
      release: async () => {
        calls.push([name, "release"]);
        state.delete(name);
      },
    }),
  };
  return { namespace, state, calls };
};
