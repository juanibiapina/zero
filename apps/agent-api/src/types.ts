// Re-export the wrangler-generated global so the rest of the code has a
// single import to lean on.
//
// ZEROVAULT_API_KEY is the single suite `zv_` key (unlocks ZeroVault and
// authorizes ZeroErrors ingest). It is a required secret: the deploy fails if
// it is unset, so it is non-optional at the type level.
export type Env = Cloudflare.Env & { ZEROVAULT_API_KEY: string };
