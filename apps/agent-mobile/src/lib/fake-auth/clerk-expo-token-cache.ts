// Fake `@clerk/expo/token-cache` for the hermetic E2E profile. The fake
// ClerkProvider ignores its tokenCache prop, so this is an inert placeholder
// that keeps the import in _layout.tsx resolvable.
export const tokenCache = {
  getToken: async () => null,
  saveToken: async () => {},
};
