// Re-export the wrangler-generated global so the rest of the code has a
// single import to lean on.
//
// ZEROVAULT_API_KEY is the single suite `zv_` key (unlocks ZeroVault and
// authorizes ZeroErrors ingest). It is optional at the type level because it
// may be absent, which keeps error reporting a typed no-op until it is set.
export type Env = Cloudflare.Env & { ZEROVAULT_API_KEY?: string };
