import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Looser, non-type-checked preset for the relocated vault/errors products.
// Mirrors the config these apps were written and passing under before the
// move. Follow-up: converge these packages onto the strict `.` preset
// (recommendedTypeChecked) and delete this file.
export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-trailing-spaces": "error",
      "no-multiple-empty-lines": ["error", { max: 1 }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
