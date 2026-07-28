# Code quality plan

## Goal

Make the TypeScript codebase easier to navigate and change without altering gateway behavior, persistence semantics, generated service definitions, or public imports.

## Completed boundaries

The branch already contains these independently reviewed extractions:

- `src/db-schema.ts` owns the schema SQL and schema-integrity metadata.
- `src/cli/parsing.ts` owns CLI argument parsing, with focused parser tests.
- `src/control-protocol.ts` owns control request/response validation and deadlines.
- `src/control-server.ts` owns control socket framing and lifecycle.
- `src/db-validation.ts` owns persisted-row types and validation.
- `src/control-parameters.ts` owns control parameter validation and cursor codecs.
- `src/cli/control-client.ts` owns CLI control-socket requests and response handling.

The next increment must build on those modules rather than move their responsibilities again. It must not combine feature work, service behavior changes, command changes, or dependency updates with the move below.

## Next increment: daemon service-definition rendering boundary

**Scope:** `src/daemon.ts`, new `src/daemon-service-definitions.ts`, and new `test/daemon-service-definitions.test.ts`.

Move only the systemd/launchd identifiers, value-escaping helpers, and pure `systemdUnit` and `launchdPlist` renderers out of `src/daemon.ts`. Leave platform selection, injected OS dependencies, service installation and removal, process-manager commands, status detection, log following, and console reporting in `src/daemon.ts`. Re-export `SYSTEMD_SERVICE_NAME`, `LAUNCHD_LABEL`, `systemdUnit`, and `launchdPlist` from `src/daemon.ts` so current callers and `test/daemon.test.ts` keep their imports unchanged.

Behavior is preserved when:

- generated systemd units and launchd plists are byte-for-byte identical, including key order, whitespace, quoting, and the terminal newline;
- quotes and backslashes in systemd values and XML metacharacters in launchd values are escaped exactly as before;
- configured node, CLI, config, data, home, and `PATH` values, plus canonical launchd log paths, appear in the same fields;
- install, uninstall, start, stop, status, and logs actions issue exactly the same filesystem and process-manager operations; and
- the extraction introduces no `daemon.ts`/`daemon-service-definitions.ts` import cycle.

Focused validation:

```sh
pnpm exec vitest run test/daemon-service-definitions.test.ts test/daemon.test.ts
```

The new tests should import the new boundary directly and assert complete rendered output for representative systemd and launchd definitions, plus focused escaping cases containing quotes, backslashes, ampersands, and angle brackets. Existing daemon tests remain the compatibility proof for re-exports and lifecycle integration.

## Quality gate

Run the focused command, then the complete repository gate:

```sh
pnpm format:check
pnpm lint
pnpm build
pnpm test
git diff --check
```

The move is complete only when the new module has no filesystem or process side effects, old public imports continue to work, and the diff contains no opportunistic cleanup.

## Risks

The main risks are subtle generated-file byte drift, incomplete escaping after moving private helpers, accidental changes to process-manager behavior, and a type/runtime import cycle. Exact full-string assertions, special-character cases, compatibility re-exports, the unchanged lifecycle suite, and the full repository gate mitigate those risks. If the extraction requires changing daemon lifecycle logic or another completed boundary, defer that change rather than broadening the increment.
