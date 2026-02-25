import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./src/ProjectDO/db/drizzle",
  schema: "./src/ProjectDO/db/schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
