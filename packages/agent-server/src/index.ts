/**
 * Minimal HTTP stub for the agent-server container.
 *
 * The container exists as a placeholder — real agent functionality will be
 * added later. For now it just responds to health checks so the container
 * platform can verify the process is alive.
 */

import { createServer } from "node:http";

const port = parseInt(process.env.PORT ?? "8080", 10);

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});

server.listen(port, () => {
  console.log(`agent-server stub listening on port ${port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
