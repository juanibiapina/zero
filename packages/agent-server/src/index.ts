/**
 * Entry point — Start the agent-server HTTP server.
 */

import { createAppServer } from "./server.js";

const port = parseInt(process.env.PORT ?? "8080", 10);
const server = createAppServer();

server.listen(port, () => {
  console.log(`agent-server listening on port ${port}`);
});

// Graceful shutdown
const shutdown = () => {
  console.log("Shutting down...");
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
