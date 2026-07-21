// Re-export the wrangler-generated global so the rest of the code has a
// single import to lean on.
//
// ZEROERRORS_KEY is an optional secret (a `zv_` key for ZeroErrors ingest). It
// is not part of the generated Env because it may be absent; declaring it
// optional here keeps error reporting a typed no-op until the secret is set.
export type Env = Cloudflare.Env & { ZEROERRORS_KEY?: string };
