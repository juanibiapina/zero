/**
 * ============================================================================
 * AgentContainer — placeholder
 * ============================================================================
 *
 * The container binding is kept in wrangler.jsonc so we don't churn DO
 * migrations when we later add real agent functionality. Today it does
 * nothing.
 */

import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

export class AgentContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";
}
