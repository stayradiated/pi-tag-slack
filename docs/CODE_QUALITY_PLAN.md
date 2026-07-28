# Code quality plan

## Goal

Make the TypeScript codebase easier to navigate and change without altering gateway behavior, persistence semantics, or public imports.

## Completed boundaries

The branch already contains these independently reviewed extractions:

- `src/db-schema.ts` owns the schema SQL and schema-integrity metadata.
- `src/cli/parsing.ts` owns CLI argument parsing, with focused parser tests.
- `src/control-protocol.ts` owns control request/response validation and deadlines.
- `src/control-server.ts` owns control socket framing and lifecycle.

The next increments must build on those modules rather than move their responsibilities again. They must not combine feature work, schema changes, command changes, or dependency updates with the moves below.

## Increment 1: persisted-row validation boundary

**Scope:** `src/db.ts`, new `src/db-validation.ts`, and new `test/db-validation.test.ts`.

Move the pure value predicates, persisted row types, row validators, and the table-wide persisted-row validation loop out of `src/db.ts`. Keep connection ownership, pragma/schema checks, SQL operations, transactions, and timestamps in `src/db.ts`. Re-export the currently public validator functions and row types from `src/db.ts` so existing consumers do not need to change imports.

Behavior is preserved when:

- every malformed row is accepted or rejected exactly as before, with the same error text;
- validation still runs at the same read, write, startup, and doctor boundaries and in the same table order;
- `validateSchema` still performs schema checks before persisted-row checks;
- no SQL, transaction boundary, schema version, or database lifecycle behavior changes; and
- the extraction introduces no `db.ts`/`db-validation.ts` import cycle.

Focused validation:

```sh
pnpm exec vitest run test/db-validation.test.ts test/persistence-control-validation.test.ts test/gateway-foundation.test.ts test/doctor-offline.test.ts
```

The new tests should use plain row objects for each exported validator, including valid rows and representative cross-field invariant failures; existing database tests remain the integration proof.

## Increment 2: control parameter and cursor boundary

**Scope:** `src/control.ts`, new `src/control-parameters.ts`, and new `test/control-parameters.test.ts`.

Move only the pure command-parameter coercion and validation helpers plus opaque cursor codecs out of `src/control.ts`. This includes limits, state/text/path/ID checks, public list cursors, and trust cursors. Leave the command switch, database queries, coordinator serialization, Slack calls, session controls, and the already extracted protocol/server modules in place.

Behavior is preserved when:

- defaults, accepted ranges and identifier patterns are unchanged;
- failures retain the exact control error code and message;
- cursor JSON fields, base64url encoding, sort direction, and invalid-cursor behavior remain byte-for-byte compatible;
- no command name, parameter alias, result shape, pagination query, or dispatch sync/async behavior changes; and
- `dispatch` continues to validate before crossing database, Slack, or pi boundaries where it does today.

Focused validation:

```sh
pnpm exec vitest run test/control-parameters.test.ts test/persistence-control-validation.test.ts test/session-controls.test.ts test/archive-control-cli.test.ts
```

The new tests should directly cover boundary values and cursor round trips. Existing dispatch tests remain responsible for command integration and side-effect ordering.

## Increment 3: CLI control client boundary

**Scope:** `src/cli/index.ts`, new `src/cli/control-client.ts`, and new `test/cli-control-client.test.ts`.

Move the daemon control-socket client, response framing, timeout selection, and response-envelope validation out of the CLI entry point. Keep `main`, setup/doctor/daemon orchestration, presentation, and the completed parsing boundary in `src/cli/index.ts`. Preserve `request` as a re-export from `src/cli/index.ts` for compatibility with current tests and callers.

Behavior is preserved when:

- request IDs, newline-delimited JSON, maximum frame size, and command-specific deadlines are unchanged;
- connection, timeout, malformed frame, oversized frame, premature close, and daemon error paths retain their codes and request metadata;
- mutating Slack commands still do not retry after an uncertain outcome;
- sockets, listeners, and timers are cleaned up at the same terminal points; and
- CLI output, exit codes, setup behavior, doctor fallback rules, and command parsing are untouched.

Focused validation:

```sh
pnpm exec vitest run test/cli-control-client.test.ts test/control-cli-contract.test.ts test/doctor-offline.test.ts test/gateway-lock.test.ts
```

The new tests should exercise the client through a temporary Unix socket and deterministic short deadlines. Existing CLI contract tests remain the compatibility proof for `main` and the `request` re-export.

## Quality gate for every increment

Run the focused command for the increment, then the complete repository gate:

```sh
pnpm format:check
pnpm lint
pnpm build
pnpm test
git diff --check
```

Review each increment separately. A move is complete only when its new module has one clear responsibility, old public imports continue to work, and the diff contains no opportunistic cleanup.

## Risks and sequencing

Implement the increments in the listed order, but keep their commits and file scopes independent. The main risks are accidental validation drift, cursor incompatibility, and changes to timeout/socket cleanup that only appear on failure paths. Exact error assertions, compatibility re-exports, focused failure-path tests, and the full suite are required mitigations. If an extraction requires touching another increment's files, defer that change rather than broadening the commit.
