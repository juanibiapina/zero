// Fake `@clerk/expo/token-cache` for the release E2E build. The fake
// ClerkProvider ignores its tokenCache prop, so this is an inert placeholder
// that keeps the import in _layout.tsx resolvable.
export const tokenCache = {
  getToken: async () => null,
  saveToken: async () => {},
};
