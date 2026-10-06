import base from "@zero/eslint-config";

export default [
  {
    ignores: [".wrangler/**", "dist/**", "worker-configuration.d.ts"],
  },
  ...base,
];
