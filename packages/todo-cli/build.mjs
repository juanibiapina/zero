import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/zero-todo.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __zeroTodoCreateRequire } from "node:module";',
      "const require = __zeroTodoCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
