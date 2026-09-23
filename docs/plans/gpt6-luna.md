# Switch Zero's agent to GPT-6 Luna

## Goal

All Zero agent calls use OpenAI `gpt-6-luna` through the existing Cloudflare AI Gateway and Responses wire. Preserve the current reasoning policy (`high` by default, `low` for project icon suggestions), per-user attribution, cache routing, and cost accounting.

## What to change and why

1. **Pass GPT-6 Luna as a pi-ai model object.** The pinned `@earendil-works/pi-ai@0.84.3` can send a `Model` object through the registered Cloudflare gateway provider even when `getModel()` cannot find that ID. Zero's `apps/agent-api/src/agents/model-pi.ts` currently throws on that catalog miss. Define the new model's ID, Responses gateway URL, supported effort levels, and official cost metadata there, and pass it to the existing `completeSimple` call; keep the catalog lookup for other IDs. Prices per million tokens: input $0.10, cached input $0.01, cache write $0.125, output $0.50; above 272K input tokens, double the input/cache rates and multiply output by 1.5. This always sends `gpt-6-luna`, never falls back to the previous model. No package upgrade or new provider is needed. When pi-ai later publishes the model in its catalog, replace this definition with the catalog entry.
2. **Select it everywhere.** Set `MODEL_ID` to `gpt-6-luna` in `apps/agent-api/wrangler.jsonc`, `wrangler.test.jsonc`, and `wrangler.e2e.jsonc`; regenerate `worker-configuration.d.ts` with `pnpm --filter @zero/agent-api run cf-typegen`. No per-agent model overrides or effort changes are needed. Keep `gpt-5.6-luna` available for rollback by changing the production var.
3. **Keep active descriptions accurate.** Update current-model references in `AGENTS.md`, `docs/design.md`, `docs/integration-tests.md`, `docs/caching.md`, and `prompts/cost-cache-daily.md`. Check the new model's cache behavior before asserting implicit caching; leave historical plans unchanged. Add a dated, user-perspective bullet to `apps/agent-api/CHANGELOG.md` in the same change.

OpenAI's [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna) confirms the model ID, Responses function calling, image input, `high`/`low` effort, context/output limits, and prices. The existing adapter already sends these request shapes. A local mock-fetch probe with pinned pi-ai `0.84.3` sent `model: "gpt-6-luna"` and `reasoning.effort: "high"` to the gateway's `/openai/responses` route and returned a priced response, despite `getModel()` returning `undefined`. The only necessary adapter change is supplying accurate metadata for that model.

## Out of scope

No prompt, reasoning policy, agent workflow, or provider migration; no rewrite of the earlier GPT-5.6 migration plan.

## Tests and verification

- Update `apps/agent-api/src/agents/model.test.ts` so the factory builds `gpt-6-luna` for interface and learner; keep historical protocol-translation fixtures where they test wire behavior rather than defaults. Intercept a pi-ai request and assert the model ID, Responses gateway route, high/low effort, and priced usage; check standard/long-context rates in the model definition. Unknown IDs must still fail.
- Run `gob run bin/ci` as required by the repo. If host `workerd` fails on this machine, run agent-api tests, lint, and typecheck directly and report the blocked whole-repo check. Before production rollout, make one authenticated gateway smoke call (or use a test environment) to confirm the actual ID, tool calling, reasoning, and usage. After rollout, run the production Telegram integration smoke test if credentials are available; inspect Gateway/Workers Logs for model, errors, cache hits, and costs. Roll back `MODEL_ID` to `gpt-5.6-luna` if the new model fails.

## Skills to use

- `vocabulary`, `deep-modules` — keep the model metadata in the existing pi-ai adapter and its external interface unchanged.
- `documentation`, `changelog` — update active descriptions and the user-facing entry.
- `testing`, `cloudflare` — verify model selection and the gateway call.

## Acceptance criteria

Every agent label resolves to `gpt-6-luna` with its existing effort, a real gateway request succeeds through Responses, usage is priced rather than marked unpriced, tests and package checks pass, and the prior model remains a one-var rollback.
