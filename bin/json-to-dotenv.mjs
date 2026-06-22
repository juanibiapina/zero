#!/usr/bin/env node
// Read a JSON object of secrets ({ KEY: "value", ... }) on stdin and emit
// dotenv lines that wrangler's .dev.vars parser (and Vite) read back exactly.
//
// Wrangler's dotenv parser strips surrounding quotes and only unescapes \n and
// \r inside double quotes. So:
//   - multiline values  -> double-quoted with \n/\r escapes (single line)
//   - everything else    -> raw, unquoted (preserves JSON like {"id":1})
//
// Used by bin/fetch-secrets: `zv ... --format json | bin/json-to-dotenv.mjs`.

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const obj = JSON.parse(input || "{}");
  const lines = Object.keys(obj)
    .sort()
    .map((key) => {
      const value = String(obj[key]);
      if (/[\r\n]/.test(value)) {
        const escaped = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        return `${key}="${escaped}"`;
      }
      return `${key}=${value}`;
    });
  process.stdout.write(lines.join("\n") + "\n");
});
