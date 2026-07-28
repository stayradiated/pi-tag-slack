# Code quality plan

## Goal

Make the TypeScript codebase easier to navigate and change without altering gateway behavior.

## First increment

1. Separate database schema definition and schema-integrity metadata from runtime database operations.
2. Keep `src/db.ts` focused on connection lifecycle, validation, and persistence APIs.
3. Preserve the existing public API and run format, lint, build, and test gates.

## Follow-up increments

- Split control-protocol validation/serialization from socket-server lifecycle.
- Split CLI argument parsing from command dispatch and setup orchestration.
- Add focused module-level tests whenever behavior is moved, rather than broad rewrites.

Each increment should be independently reviewable and committed only with passing quality gates.
