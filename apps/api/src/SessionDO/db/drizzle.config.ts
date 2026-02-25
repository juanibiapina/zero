import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./src/SessionDO/db/drizzle",
  schema: "./src/SessionDO/db/schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
