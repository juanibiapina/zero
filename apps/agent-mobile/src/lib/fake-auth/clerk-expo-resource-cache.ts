// The fake ClerkProvider ignores this cache. The inert export keeps root layout
// imports inside the hermetic alias set and away from Clerk persistence.
export const resourceCache = {
  get: async () => null,
  save: async () => {},
  remove: async () => {},
};
