# Refactor Follow-up Issues

These issues were found during review of the completed `docs/REFACTOR_PLAN.md` implementation. The first three block the `0.1.0` release.

## Release blockers

### 1. Bootstrap trust into the database written to config

**Priority:** High  
**Area:** Setup, configuration, trust

`pi-tag-slack setup` can initialize trust in a different database from the one written to the generated `config.env`.

Configuration is loaded before setup writes the new file. If the setup process has an overriding `DB_PATH`, `db.initDb()` uses that path while `buildConfigFile()` writes the platform default path. A subsequent invocation without the environment override opens the generated default database, finds no trusted users, and refuses to start.

#### Tasks

- Make setup calculate one explicit `sessionsDir` and `dbPath` for the generated configuration.
- Initialize trust using that exact database path rather than a stale module-level configuration snapshot.
- Avoid relying on re-importing `config.ts`; ESM module caching means it will not reload the generated file automatically.
- Ensure setup closes the explicitly opened database on both success and failure.
- Add a non-interactive integration test using:
  - A temporary `PI_TAG_SLACK_CONFIG` path.
  - An environment-level `DB_PATH` that differs from the generated path.
  - Valid Slack token placeholders and a trusted user ID.
- Assert that the trusted user exists in the database referenced by the generated config.
- Assert that setup does not create or bootstrap an unintended database.
- Verify a normal subsequent startup resolves the same database and sees the trusted user.

#### Acceptance criteria

- Setup writes and initializes exactly one intended database.
- The generated `DB_PATH` and bootstrapped database always agree.
- Startup immediately after setup does not report an empty trust list.

---

### 2. Make dotenv serialization round-trip safely

**Priority:** High  
**Area:** Setup, generated configuration

`serializeDotenvValue()` currently escapes quotes and backslashes in a form that `dotenv.parse()` does not reverse. Values containing quotes or backslashes are therefore changed when loaded. A backslash followed by `n` may also become a newline.

#### Tasks

- Replace the current serializer with one whose output round-trips through the installed `dotenv` parser.
- Continue rejecting NUL, carriage-return, and newline characters.
- Use the serializer for every generated assignment.
- Add table-driven tests that serialize, parse, and compare:
  - Empty strings.
  - Spaces.
  - `#` characters.
  - Double quotes.
  - Single quotes.
  - Backslashes.
  - Literal `\n` and `\r` sequences.
  - Values containing combinations of those characters.
- Add rejection tests for NUL, carriage return, and newline injection.
- Parse a complete `buildConfigFile()` result and assert that all supplied values are recovered exactly.

#### Acceptance criteria

```ts
parse(`VALUE=${serializeDotenvValue(input)}`).VALUE === input;
```

holds for every accepted input.

---

### 3. Add direct trust-boundary tests

**Priority:** High  
**Area:** Security, Slack handlers, queue, setup

The trust checks appear correctly placed, but the security-critical suites agreed in the refactor plan were not implemented. Trust is the primary boundary preventing Slack users from executing code on the gateway machine, so indirect coverage is insufficient.

#### Tasks

##### Database trust tests

Add `test/trust-db.test.ts` covering:

- Exact acceptance of uppercase `U...` and `W...` IDs.
- Rejection of lowercase IDs, display names, mention syntax, whitespace, and invalid characters.
- Idempotent insertion.
- Stable trusted-user ordering.
- Refusal to remove the final trusted user.
- Atomic user removal and pending-message deletion.
- Preservation of other users' pending messages.
- Preservation of processing work during direct revocation.

##### Queue authorization tests

Cover:

- Startup recovery resetting processing rows.
- Startup recovery marking revoked users' rows failed.
- Execution-time rejection after a row is claimed.
- No `invokeAgent()`, Slack reaction, Slack response, or message-log side effect for rejected rows.
- Trusted messages continuing normally.
- `sender === 'scheduler'` remaining authorized.

##### Slack authorization tests

Create a direct test seam for inbound message handling rather than mocking all of Bolt or exporting `_test` internals.

For messages, slash commands, and Block Kit actions, add both untrusted and trusted control cases.

Assert that untrusted messages do not perform:

- User or conversation lookups.
- Channel/DM registration.
- Attachment processing.
- Queue insertion.
- Slack notices or responses.

Assert that untrusted slash commands and actions:

- Are acknowledged.
- Do not respond.
- Do not perform lookups or mutations.
- Use the acting user's ID for authorization.

##### Setup and startup tests

Cover:

- Non-interactive setup requiring the initial trusted user ID.
- Trust bootstrap in the configured database.
- The trusted user ID not being written to `config.env`.
- New and overwritten config files ending with mode `0600`.
- Gateway startup refusing an empty trust list.
- Gateway startup proceeding once a trusted user exists.

#### Acceptance criteria

- Every user-initiated Slack entry point has trusted and untrusted tests.
- Rejected messages have no agent or Slack side effects.
- Crash recovery cannot execute work from a revoked user.
- The scheduler exception is explicitly tested.

---

## Required before release

### 4. Replace skipped migration tests with schema-version tests

**Priority:** Medium  
**Area:** SQLite schema

`test/db-cwd.test.ts` contains two skipped legacy migration suites. The first-release baseline no longer supports those migrations, but no schema-version-1 tests replaced them.

`initDb()` also marks the global database state open before schema validation. If validation throws, the connection remains open and subsequent calls may incorrectly return early.

#### Tasks

- Delete the two skipped legacy migration suites instead of retaining them with `describe.skip()`.
- Add schema baseline tests for:
  - New database creation.
  - Complete final table columns.
  - `PRAGMA user_version = 1`.
  - Reopening a version-1 database.
  - Rejection of a version-0 database containing application tables.
  - Rejection of a schema newer than version 1.
- Refactor `initDb()` so `dbOpen` becomes true only after successful validation and initialization, or ensure failures close the connection and reset state.
- Test that initialization can be attempted safely after a rejected database is closed or replaced.

#### Acceptance criteria

- The test run contains no skipped schema tests.
- Initialization failure never leaves `dbOpen` or the SQLite connection in a stale state.
- Version-1 schema behavior is directly covered.

---

### 5. Finish strict CLI validation

**Priority:** Medium  
**Area:** CLI parsing

Several agreed strict-input rules remain incomplete.

#### Tasks

- Validate `--thread` with `^\d+\.\d+$` before any Slack API call.
- Stop trimming `PI_TAG_SLACK_TRUSTED_USER_ID` and interactive trust input before validation.
- Normalize channel IDs before deriving default session folder names.
- Ensure `C123...` and `sl:C123...` produce the same normalized JID and default folder.
- Add a regression test proving re-registering with the alternate accepted form does not change the session folder.
- Require explicit values for all `task add` options rather than allowing the next flag to be consumed as a value.
- Consider rejecting duplicate singleton options such as repeated `--channel`, `--thread`, `--name`, or `--dry-run`.
- Add malformed-input tests for every corrected path.

#### Acceptance criteria

- Invalid thread timestamps fail locally without network access.
- Trusted user IDs are validated exactly as supplied.
- Bare and `sl:`-prefixed channel IDs behave identically.
- Missing option values always produce the documented usage error.

---

### 6. Reconcile documentation and runtime naming

**Priority:** Low  
**Area:** README, daemon identity, defaults

The README and runtime contain several inconsistencies left by the hard rename.

#### Tasks

- Replace the sentence saying both `pi-tag-slack` and `pi-tag-slack` commands are installed with a statement that only `pi-tag-slack` is installed.
- Remove the duplicate `## Access control` / `## Security and access control` heading.
- Decide and consistently document the default trigger:
  - Runtime and `.env.example` currently use `pi-tag-slack`.
  - README examples and the configuration table currently say `pi`.
- Ensure bare-trigger examples match the selected default.
- Keep `/pi` as the Slack slash command.
- Change the launchd identifier to the agreed `com.stayradiated.pi-tag-slack`, including:
  - Plist filename.
  - Plist label.
  - Daemon status lookup.
  - README documentation.
  - Tests.
- Run a final stale-name and duplicate-heading search.

#### Acceptance criteria

- README, `.env.example`, setup defaults, and runtime defaults agree.
- `/pi` remains the Slack slash command.
- launchd consistently uses `com.stayradiated.pi-tag-slack`.
- No duplicated command aliases or headings remain.

---

## Final verification

After resolving all issues, run:

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run format:check
pnpm run build
pnpm test
pnpm audit --prod --audit-level high
pnpm pack --pack-destination /tmp/pi-tag-slack-pack
node dist/cli/index.js help
```

Expected result:

- No failing or skipped tests.
- No production audit findings.
- Package is `@stayradiated/pi-tag-slack@0.1.0`.
- Only the `pi-tag-slack` binary is exposed.
- Packed contents contain only intended runtime files and release documentation.
