# Reduce tooling output in agent sessions

## Bottom line

Reduce avoidable command-output tokens through existing Turbo, Jest, and Maestro
configuration. Successful repository checks become quiet, model-facing Maestro
output becomes compact and non-ANSI, and failure diagnostics and mobile test
artifacts remain available.

This is an internal tooling change. It does not change application behavior, the
Telegram bridge, Pi, models, context alerts, compaction, or provider settings.

## Goal

After this change:

- successful Turbo tasks emit only a short task identity and hash;
- mobile Jest suppresses `console.*` noise while preserving test failures;
- repository-owned Maestro test commands emit no ANSI decoration;
- model-facing Maestro hierarchy inspection uses compact CSV;
- screenshots, logcat, JUnit, debug output, and UI hierarchy artifacts remain
  unchanged.

## Current state

- `turbo.json` leaves `outputLogs` at Turbo's `full` default. Turbo 2.10.8 supports
  `outputLogs: "errors-only"` and `futureFlags.errorsOnlyShowHash`.
- Turbo task-specific definitions do not inherit omitted settings from generic
  definitions. A dry-run probe showed `@zero/dashboard-api#test`,
  `@zero/agent-api#deploy`, and `@zero/dashboard-api#deploy` remain `full` when
  only generic `test` and `deploy` definitions change.
- Mobile Jest runs serially but has no `silent` setting.
- Vitest 4.1.10 already selects its built-in `agent` reporter when `std-env`
  detects Pi from the process `PATH`. Vitest needs no change.
- Maestro 2.8.0 supports the global `--no-ansi` option and
  `hierarchy --compact`.
- Three Maestro shell harnesses persist JUnit, debug output, screenshots, logcat,
  and UI hierarchy files. Console cleanup must not alter those artifacts.
- Current Maestro command examples also appear in root `AGENTS.md`, the mobile
  README, and four development-flow comments.

## What to change and why

### 1. Make finite Turbo tasks quiet on success

Set `outputLogs: "errors-only"` on the generic `build`, `lint`, `typecheck`,
`test`, and `deploy` task definitions in `turbo.json`. Keep `dev` unchanged
because live logs are part of a persistent development task's interface.

Repeat `outputLogs: "errors-only"` on the three task-specific definitions that
otherwise fall back to full output:

- `@zero/dashboard-api#test`;
- `@zero/agent-api#deploy`;
- `@zero/dashboard-api#deploy`.

Enable `futureFlags.errorsOnlyShowHash` so successful and cached tasks still
show a short identity and hash. Failed task logs remain visible. A diagnostic
rerun can pass `--output-logs=full`.

Do not add pnpm reporter flags. They do not control output from Turbo, Jest,
Vitest, Expo, EAS, or Maestro children.

### 2. Suppress mobile Jest console noise

Add `silent: true` to the existing Jest configuration in
`apps/agent-mobile/package.json`. This suppresses test and runtime `console.*`
output without suppressing assertion failures or stack traces.

Document this focused diagnostic override in the mobile README:

```bash
pnpm --filter @zero/agent-mobile exec jest --runInBand --silent=false <test>
```

Do not configure Vitest. Its installed reporter already provides concise output
for Pi sessions while preserving ordinary human behavior elsewhere.

### 3. Remove ANSI and compact Maestro hierarchy output

Use Maestro's global option in executable commands:

```text
maestro --no-ansi test ...
maestro --no-ansi hierarchy --compact
```

Apply `maestro --no-ansi test` to:

- `apps/agent-mobile/.maestro/run-e2e.sh`;
- `apps/agent-mobile/.maestro/run-release-emulator.sh`;
- `apps/agent-mobile/.maestro/run-release.sh`;
- command comments in all four `apps/agent-mobile/.maestro/dev/*.yaml` flows;
- current test examples in `apps/agent-mobile/README.md`.

Update root `AGENTS.md` to prescribe compact, non-ANSI hierarchy inspection and
non-ANSI test execution for model-facing work. Keep `maestro studio` unchanged.

Do not change Maestro flows, assertions, or artifact capture. JUnit XML, debug
output, screenshots, logcat, and `uiautomator` XML stay complete files outside
model context until explicitly read.

## Out of scope

- Telegram bridge or `juanibiapina/agent` changes.
- Bash-result truncation or output rewriting.
- Context warnings, models, context windows, compaction, reasoning, or providers.
- Pi SDK, global Pi, Gob, pnpm reporter, or Vitest configuration changes.
- Removing or reducing mobile assertions or test artifacts.
- Application behavior or UI changes.
- Rewriting historical plans that contain old command forms.

## Tests and verification

This change needs configuration-level verification only. It changes no app code,
native configuration, runtime behavior, UI, or Maestro flow behavior. Do not run
the Pixel 7, an emulator, Metro, Gradle, an Expo export, a native build, or a
Maestro flow.

Run exactly these checks:

1. Inspect `turbo run <task> --dry-run=json` at
   `resolvedTaskDefinition.outputLogs` for `build`, `lint`, `typecheck`, `test`,
   `deploy`, and `dev`. Turbo parsing validates `turbo.json`. Prove every finite
   generic and task-specific definition is `errors-only`; prove `dev` remains
   `full`.
2. Run the complete mobile Jest suite serially. Use temporary passing and failing
   probe tests to prove `console.*` output is hidden while assertion diagnostics
   and the failure stack remain visible. Remove both probes before staging.
3. Run one filtered successful Turbo test task and confirm the console contains
   only its short task identity/hash rather than the Jest log.
4. Run `bash -n` on all three changed Maestro harnesses.
5. Run `maestro --no-ansi test --help` and
   `maestro --no-ansi hierarchy --compact --help` to prove the documented option
   combinations parse without requiring a device.
6. Run `git diff --check`.

Do not run mobile lint or typecheck because no JavaScript or TypeScript source
changes. Do not run whole-repository `bin/ci`; it does not test these output
contracts directly and cannot finish on this NixOS host because `workerd` cannot
start.

## Documentation and changelog

- Root `AGENTS.md` owns model-facing Maestro command rules.
- `apps/agent-mobile/README.md` owns human diagnostics and Pixel procedures.
- Flow comments keep their local invocation accurate.
- Add no changelog entry. The change affects development-tool output only and
  changes no user-visible product behavior.

## Skills to use during implementation

- `expo-overview` — load before changing or verifying the Expo mobile package.
- `testing` — prove quiet success and preserved failure diagnostics.
- `documentation` — update current command sources without duplicating rationale.
- `reproducible-locally` — verify the exact resolved configurations and CLI output.
- `git-commit` — stage and commit the tooling files together when requested.

## Acceptance criteria

- Generic `build`, `lint`, `typecheck`, `test`, and `deploy` tasks use
  `errors-only` output.
- The three current task-specific overrides also resolve to `errors-only`.
- `dev` retains full live output.
- Successful tasks retain a short identity and hash.
- Mobile Jest suppresses console noise while preserving assertion failures and
  stack traces.
- Repository-owned Maestro test commands disable ANSI.
- Model-facing hierarchy inspection uses compact CSV without ANSI.
- JUnit, debug output, screenshots, logcat, UI hierarchy files, and flow
  assertions remain unchanged.
- Focused checks pass.

## Risks and mitigations

- **Task-specific Turbo definitions can bypass generic settings.** Assert every
  resolved task in dry-run JSON rather than inspecting only the generic config.
- **Successful deploy detail becomes hidden.** Keep `--output-logs=full` as an
  explicit diagnostic override.
- **Jest `silent` can hide deliberate debugging.** Keep `--silent=false` as a
  focused rerun override.
- **Command cleanup can accidentally weaken evidence.** Change only Maestro
  console flags and command examples; leave every artifact path and assertion
  untouched.
