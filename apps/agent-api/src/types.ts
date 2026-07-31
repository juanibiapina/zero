// Re-export the wrangler-generated global so the rest of the code has a
// single import to lean on.
//
// ZEROVAULT_API_KEY is the single suite `zv_` key (unlocks ZeroVault and
// authorizes ZeroErrors ingest). It is a required secret: the deploy fails if
// it is unset, so it is non-optional at the type level.
//
// ENVIRONMENT is "production" on the deployed Worker and "development" locally
// (from .dev.vars). Error reporting is gated on it so local runs and tests
// never write into the production issue list. Optional at the type level
// because it is absent in unit tests that build a bare env object.
export type Env = Cloudflare.Env & {
  ZEROVAULT_API_KEY: string;
  ENVIRONMENT?: string;
};
