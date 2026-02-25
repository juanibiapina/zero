import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./src/UserDO/db/drizzle",
  schema: "./src/UserDO/db/schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
