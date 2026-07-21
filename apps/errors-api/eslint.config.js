import base from "@zero/eslint-config";

export default [
  { ignores: [".wrangler/**"] },
  ...base,
  {
    // Tests run under vitest-pool-workers. A monorepo-hoisted `@types/jsdom`
    // (pulled by the mobile app's jest) leaks `lib.dom` into eslint's
    // projectService program, so `Response.json()` types as DOM's `any`. tsc
    // (correctly) sees `unknown`, so the tests' `as`-narrowing is required — but
    // eslint reads it as redundant/unsafe. Relax the affected rules for tests
    // only; source keeps full strict type-aware linting.
    files: ["src/tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
];
