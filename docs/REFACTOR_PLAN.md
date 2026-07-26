# pi-tag-slack Refactor Plan

## Purpose

Prepare the repository for its first public release as **pi-tag-slack** (`0.1.0`). The refactor will harden the Slack trust boundary, complete the product rename, remove pre-release compatibility code and stale documentation, tighten CLI/config behavior, and leave the repository with a clean release baseline.

This is a hard rename and a first release. There are no existing users or compatibility guarantees to preserve.

## Agreed decisions

- Trust is enforced both when Slack input is received and again when queued work begins execution.
- Scheduled tasks bypass Slack-user trust through the internal sender marker `scheduler`.
- Recovered or pending messages from untrusted users are marked failed without invoking pi or contacting Slack.
- Security-critical trust behavior receives direct tests across messages, slash commands, and Block Kit actions.
- The project, binary, paths, service identifiers, and product-specific environment variables are renamed to `pi-tag-slack`.
- Old `pitag` and `pi-tag` binaries and paths are removed without aliases or migration support.
- The first public package version is `0.1.0`.
- Pre-release database migrations are removed; the final schema becomes schema version 1.
- Broad module splitting is deferred. Only refactoring needed to create authorization test seams is in scope.
- CLI parsing becomes strict without adding a CLI framework.
- Generated dotenv values are always safely quoted.
- Test logging is silent by default.
- `PLAN.md` and `docs/RESEARCH.md` are deleted rather than archived.

---

## 1. Harden queued-message authorization

### 1.1 Central authorization rule

Add one shared queue authorization helper with these semantics:

```text
sender == "scheduler"  -> authorized
sender is trusted      -> authorized
otherwise              -> unauthorized
```

The helper must be used by both startup recovery and execution-time authorization so the two paths cannot drift.

The `scheduler` exception is intentionally narrow. Do not add other magic senders or permit arbitrary local sender names to bypass trust.

### 1.2 Transactional startup recovery

Replace the current standalone `recoverStuckMessages()` behavior with one transactional database operation, conceptually:

```ts
recoverQueueForStartup(): {
  recoveredProcessing: number;
  rejectedUnauthorized: number;
}
```

Within one SQLite transaction:

1. Reset all `processing` rows to `pending`. These represent work interrupted by a previous process exit.
2. Find all `pending` rows where:
   - `sender != 'scheduler'`; and
   - no matching `trusted_users.user_id` exists.
3. Mark those rows `failed` and set `processed_at = datetime('now')`.
4. Return both affected-row counts.

Invoke this operation from `startProcessingLoop()` before dispatch begins. Log non-zero counts locally without logging message content.

This cleanup covers:

- Messages left by a pre-trust development database.
- A user revoked while the daemon was stopped.
- A row that was `processing` during a crash and becomes pending during recovery.
- Stale unauthorized rows that would otherwise consume queue slots.

### 1.3 Execution-time revalidation

After a row is claimed and before any user-visible processing side effect:

1. Apply the shared queue authorization rule.
2. If unauthorized:
   - Do not call `invokeAgent()`.
   - Do not add or remove Slack reactions.
   - Do not send a Slack response.
   - Do not write the message to the agent-facing message log.
   - Mark the queue row `failed`.
   - Emit only a debug log containing identifiers such as `rowid`, `jid`, and sender ID.
   - Never log message content.
3. If authorized, continue through normal busy-reaction, logging, invocation, and response behavior.

Passing this check defines the start of active execution. If the user is revoked after this boundary, the already-active task may finish.

### 1.4 Revocation semantics

Retain transactional user removal:

1. Validate the exact raw Slack user ID.
2. Refuse to remove the final trusted user.
3. Delete the trusted-user row.
4. Delete that sender's `pending` queue rows in the same transaction.
5. Do not abort active work.

The execution-time check and startup recovery handle rows that were already claimed or were recovered after a crash.

### 1.5 Inbound Slack surfaces

Keep trust checks at the beginning of every user-initiated Slack path.

#### Messages

After confirming that an event has a real, non-bot `event.user`, check trust before:

- User or conversation lookups.
- DM/channel policy processing.
- Automatic registration.
- Attachment processing.
- Queue insertion.
- Registration notices or any other Slack response.

Untrusted messages return silently. A debug log containing only the user ID is acceptable.

#### Slash commands

For `/pi`:

1. Always call `ack()` within Slack's deadline.
2. Check `command.user_id` immediately afterward.
3. Return silently if untrusted.
4. Do not respond, register channels, inspect models, mutate sessions, or touch the queue.

#### Block Kit actions

For every panel action:

1. Always call `ack()`.
2. Check `body.user.id`, which is the acting user.
3. Return silently if untrusted.
4. Do not use the user who originally opened the panel as the authorization identity.

### Acceptance criteria

- No untrusted Slack message can invoke pi, including after a crash or restart.
- Revoked users' pending messages are cleared.
- Crash-interrupted messages from revoked users become failed during startup recovery.
- Scheduled tasks continue to execute.
- Unauthorized execution attempts produce no Slack side effects.

---

## 2. Add trust-boundary tests

### 2.1 Test seams

Perform only the minimum refactor needed for direct handler tests:

- Extract inbound message handling into a callable handler with injected Slack and database operations.
- Keep production Bolt registration thin.
- Test slash commands and actions by passing a small fake `App` that captures registered callbacks.
- Do not export `_test` objects or mock the complete Bolt implementation.
- Do not broadly reorganize unrelated Slack or CLI code.

### 2.2 Database trust suite

Add a focused suite such as `test/trust-db.test.ts` covering:

- Exact acceptance of uppercase `U...` and `W...` IDs.
- Rejection of lowercase IDs, display names, Slack mention syntax, surrounding whitespace, and invalid characters.
- Idempotent insertion and clear return values.
- Stable trusted-user ordering.
- Removal of a trusted user.
- Refusal to remove the final trusted user.
- Atomic deletion of only that user's pending messages.
- Preservation of other users' pending messages.
- Preservation of active/processing work during direct revocation.
- Startup recovery subsequently rejecting processing work from a revoked user.
- Scheduler rows surviving startup authorization cleanup.

### 2.3 Slack authorization suite

Add a suite such as `test/slack-auth.test.ts` covering all three inbound surfaces.

For each surface, include both an untrusted case and a trusted control case. This prevents a handler that ignores everyone from satisfying the rejection tests.

#### Message assertions

For an untrusted message, assert that none of these occur:

- User lookup.
- Conversation lookup.
- Channel/DM registration.
- Attachment selection or processing.
- Queue insertion.
- Slack response or notice.

For a trusted message, assert that normal handling proceeds.

#### Slash command assertions

For an untrusted command:

- `ack()` is called.
- `respond()` is not called.
- No state-changing or lookup dependency is called.

Include a trusted command control.

#### Block action assertions

For an untrusted action:

- `ack()` is called.
- `respond()` is not called.
- The action callback is not run.

Include a trusted action control and ensure authorization uses `body.user.id`.

### 2.4 Setup and startup suite

Add integration coverage, potentially in `test/trust-startup.test.ts`, for:

- Non-interactive setup requiring both Slack tokens and the initial trusted user ID.
- Setup writing the trusted user to the configured database.
- Setup not writing the bootstrap user ID into `config.env`.
- Generated `config.env` mode being exactly `0600` on supported POSIX platforms.
- Gateway startup refusing an empty trust list with a clear command using the new binary name.
- Gateway startup proceeding once a trusted user exists.

### Acceptance criteria

- Every user-initiated Slack entry point has trusted and untrusted tests.
- Queue recovery and execution-time checks have regression tests.
- Tests verify absence of side effects, not merely return values.

---

## 3. Complete the hard rename to pi-tag-slack

### 3.1 Canonical identity

Use these canonical identities:

| Surface               | New value                                      |
| --------------------- | ---------------------------------------------- |
| Product               | `pi-tag-slack`                                 |
| npm package           | `@stayradiated/pi-tag-slack`                   |
| GitHub repository     | `https://github.com/stayradiated/pi-tag-slack` |
| CLI binary            | `pi-tag-slack`                                 |
| systemd unit          | `pi-tag-slack.service`                         |
| launchd label         | `com.stayradiated.pi-tag-slack`                |
| Config/data directory | `pi-tag-slack`                                 |

Update the local Git `origin` to the renamed GitHub repository.

### 3.2 Binary

Change `package.json` so it exposes only:

```json
{
  "bin": {
    "pi-tag-slack": "dist/cli/index.js"
  }
}
```

Remove `pitag` and `pi-tag` aliases entirely.

Update every generated agent instruction, help line, error message, README example, daemon command, setup message, and test fixture to invoke `pi-tag-slack`.

### 3.3 Persistent paths

Use the following defaults:

#### Linux

- Config: `~/.config/pi-tag-slack/config.env`
- Data: `~/.local/share/pi-tag-slack/`
- Sessions: `~/.local/share/pi-tag-slack/sessions/`
- Database: `~/.local/share/pi-tag-slack/gateway.db`

#### macOS

- Config/data: `~/Library/Application Support/pi-tag-slack/`
- Config file: `~/Library/Application Support/pi-tag-slack/config.env`
- Sessions and database live beneath the same directory.

Do not probe, copy, or migrate old `pitag` paths.

### 3.4 Product-specific environment variables

Rename only product-specific variables:

| Old                     | New                            |
| ----------------------- | ------------------------------ |
| `PITAG_CONFIG`          | `PI_TAG_SLACK_CONFIG`          |
| `PITAG_TRUSTED_USER_ID` | `PI_TAG_SLACK_TRUSTED_USER_ID` |

Keep functional configuration names unchanged, including:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `PI_BIN`
- `PI_MODEL`
- `PI_THINKING`
- `PI_CWD`
- `DB_PATH`
- `SESSIONS_DIR`
- Policy and concurrency variables

Do not support old variable aliases.

### 3.5 Daemon identity

Update daemon generation and management:

- systemd service file and commands use `pi-tag-slack.service`.
- launchd uses `com.stayradiated.pi-tag-slack`.
- Log paths and generated comments use `pi-tag-slack`.
- Service `ExecStart` targets the `pi-tag-slack` installation.
- Status and setup output use the new name consistently.

### 3.6 Slack-facing identity

Apply the hard rename to Slack-facing product surfaces:

- Manifest app and bot display names use `pi-tag-slack`.
- Keep the concise Slack slash command `/pi` as an intentional user-facing exception to the hard product rename.
- Manifest command descriptions and usage are updated without renaming the command.
- Interactive panel titles and fallback text use `pi-tag-slack`.
- Default trigger name becomes `pi-tag-slack`.

Internal protocol identifiers that are not product names remain unchanged, including the generic Slack JID prefix `sl:`.

### 3.7 Repository metadata

Normalize:

- `package.json` repository, homepage, and bugs URLs.
- README badges and clone instructions.
- Contribution and issue-template links.
- Security policy wording.
- Release workflow package references.
- Source comments and generated config headers.

Preserve legitimate upstream copyright and attribution. A hard product rename does not erase authorship history.

### Acceptance criteria

Run a repository-wide case-insensitive search for:

```text
pitag
pi-tag (when not part of pi-tag-slack)
Crokily/pi-tag
stayradiated/pi-tag (when not followed by -slack)
PITAG_
com.pitag
```

Every remaining occurrence must be either deliberate historical attribution or removed.

---

## 4. Establish first-release version and changelog

### 4.1 Package version

Set `package.json` to:

```json
{
  "version": "0.1.0"
}
```

Regenerate `pnpm-lock.yaml` so its importer metadata matches.

### 4.2 Changelog

Replace the pre-release fictional `0.1.0` through `0.2.1` sequence with a single first-release entry describing the finished product.

The `0.1.0` entry should cover:

- Slack Socket Mode gateway.
- Explicit trusted-user access control.
- Persistent per-channel sessions and queue recovery.
- Threaded user responses.
- Incoming and explicit outgoing file support.
- Scheduled tasks.
- Interactive Slack control panel.
- Linux/macOS daemon support.
- Setup and diagnostics CLI.

Do not include upgrade instructions or compatibility notes because there has been no prior public release.

### 4.3 Release workflow

Retain:

- Full-SHA action pinning.
- npm Trusted Publishing with OIDC.
- Provenance.
- Tag/package version verification.
- Stable/prerelease npm tag behavior.

Ensure the workflow uses the renamed package and pnpm commands consistently.

### Acceptance criteria

- `pnpm view @stayradiated/pi-tag-slack` is expected to remain absent until release.
- A `v0.1.0` tag matches `package.json`.
- `pnpm pack` reports `@stayradiated/pi-tag-slack@0.1.0` and contains only intended files.

---

## 5. Prune and normalize documentation

### 5.1 Remove implementation artifacts

Delete:

- `PLAN.md`
- `docs/RESEARCH.md`

Git history is sufficient if their historical context is ever needed.

### 5.2 Keep README as the user documentation source

Retain a single comprehensive README for `0.1.0`. Update it to:

- Use the `pi-tag-slack` product name throughout.
- Use `pi-tag-slack` for every CLI example.
- Continue using `/pi` for Slack command examples.
- Document the renamed paths and environment variables.
- Preserve the prominent trust/security warning.
- Remove the duplicate `Access control` heading.
- Point clone, issue, security, package, and repository links at canonical locations.
- Describe only Linux and macOS support.
- Avoid compatibility or migration sections for old names.

### 5.3 Contributor documentation

Update `CONTRIBUTING.md`, templates, and examples to use:

- The canonical repository URL.
- pnpm only.
- The final quality-gate commands.
- The new binary and configuration names.

### Acceptance criteria

- No stale clone URL or old binary appears in active documentation.
- README headings are unique and logically ordered.
- User-facing behavior in README matches code and manifest.

---

## 6. Create a clean schema version 1

### 6.1 Final schema definition

Move all currently added columns into the initial `CREATE TABLE` statements. In particular, `message_queue` must be created with its final columns, including:

- `attachments`
- `event_ts`
- `thread_ts`

Remove `ensureTableColumn()` and all pre-release legacy migration tests.

### 6.2 SQLite user version

Use `PRAGMA user_version` as the schema anchor:

- A new empty database is initialized with the complete schema and `user_version = 1` in one transaction.
- A database at version 1 opens normally.
- A database with a version greater than 1 is rejected as unsupported.
- A pre-release database containing application tables at version 0 is rejected with a clear instruction to delete/recreate it; do not attempt migration.

This creates a clean starting point for explicit ordered migrations after `0.1.0`.

### 6.3 Schema tests

Test:

- New in-memory database creation.
- Complete `message_queue` columns.
- `user_version = 1` after initialization.
- Reopening a version-1 database.
- Rejection of a newer unsupported schema.
- Clear handling of a pre-release version-0 application database.

### Acceptance criteria

- No runtime `ALTER TABLE` occurs in the `0.1.0` baseline.
- Database initialization is deterministic and transactionally establishes version 1.

---

## 7. Tighten CLI parsing and Slack identifier validation

### 7.1 Parsing approach

Do not add a CLI framework. Introduce small shared parsing/validation helpers and apply them consistently.

Every command must:

- Require values for value-taking options.
- Reject unknown options.
- Reject unexpected positional or trailing arguments.
- Return command-specific usage text.
- Avoid silently normalizing malformed identifiers.

Apply strict parsing to all commands, including commands that take no arguments, such as `channels`, `trust list`, and `archive list`.

### 7.2 Slack ID validation

Create a shared exact Slack ID validator parameterized by allowed prefixes.

Validate the original input without trimming or case conversion:

```text
User ID:    ^[UW][A-Z0-9]+$
Channel ID: ^[CGD][A-Z0-9]+$
```

For channel JIDs, accept an optional exact `sl:` prefix, strip it, validate the raw ID, and return the normalized `sl:<id>` form.

Do not enforce a fixed ID length because Slack ID lengths have changed historically.

### 7.3 Other validation

- Thread timestamps: `^\d+\.\d+$`
- Task IDs: positive base-10 integers only; reject zero, negatives, decimals, and trailing text.
- Trust IDs: reject display names, `<@U...>` syntax, lowercase, and surrounding whitespace.

### 7.4 Commands to cover

At minimum, verify strict behavior for:

- `setup`
- `start`
- `status`
- `channels`
- `register`
- `unregister`
- `send`
- `trust add/remove/list`
- `task add/list/remove/enable/disable`
- `archive list/cleanup`
- `daemon install/uninstall/start/stop/status/logs`
- `help`

### Acceptance criteria

- No documented command silently ignores extra input.
- Invalid Slack IDs fail locally before database or network access.
- Existing valid command forms remain straightforward.

---

## 8. Make generated dotenv configuration safe

### 8.1 Uniform serialization

Add one dotenv value serializer used by `buildConfigFile()`.

Every generated assignment must be double quoted, including numeric and empty values:

```env
MAX_CONCURRENCY="3"
PI_MODEL=""
PI_CWD="/home/user/projects#archive"
```

The serializer must:

- Preserve spaces and `#` characters.
- Escape quotes and backslashes correctly for the `dotenv` parser.
- Reject NUL, carriage-return, and newline characters.
- Produce a value that round-trips through `dotenv.parse()`.

Do not hand-roll slightly different quoting at individual call sites.

### 8.2 Example configuration

Mirror the quoted assignment style in `.env.example`, while retaining explanatory comments.

Use the renamed paths and product-specific variables.

### 8.3 File permissions

Continue to:

1. Write the config file.
2. Call `chmodSync(configPath, 0o600)` afterward.

The explicit chmod is required because a write mode only reliably applies when creating a new file.

### 8.4 Tests

Test round trips for values containing:

- Spaces.
- `#`.
- Quotes.
- Backslashes.
- Empty strings.

Test rejection of newline and NUL injection. Test mode `0600` for both new and overwritten config files.

### Acceptance criteria

- `dotenv.parse(buildConfigFile(...))` reproduces every input value exactly.
- Existing config files have permissions corrected to `0600` after setup.

---

## 9. Fix formatting ownership

Update `.prettierignore`:

- Add `pnpm-lock.yaml`.
- Remove the obsolete `package-lock.json` entry.

Treat pnpm as the sole formatter for its generated lockfile. Continue validating consistency with:

```bash
pnpm install --frozen-lockfile
```

### Acceptance criteria

- `pnpm run format:check` passes without rewriting `pnpm-lock.yaml`.
- No npm lockfile exists or is tracked.

---

## 10. Silence test logging

Set `LOG_LEVEL=silent` in the Vitest environment globally.

Do not introduce logger dependency injection solely for this purpose. Individual future logger tests may override the environment explicitly.

### Acceptance criteria

- Normal test runs show Vitest results without database migration or queue-processing log noise.
- Production and development logging behavior is unchanged.

---

## 11. Limit structural refactoring

The following broad splits are explicitly deferred until after `0.1.0`:

- Breaking `src/cli/index.ts` into one module per command.
- Splitting all database operations into repositories.
- Splitting all Slack command handlers by feature.
- Reorganizing agent invocation internals.

Permitted structural changes are limited to:

- Extracting inbound Slack handling for direct authorization tests.
- Adding shared authorization and validation helpers.
- Replacing pre-release schema migration helpers with schema-version initialization.

Any additional refactor must be justified by a concrete correctness or testability requirement and kept separate from behavior changes where practical.

---

## 12. Implementation sequence

### Phase 1: Security behavior

1. Add the shared queue sender authorization rule.
2. Implement transactional startup recovery and unauthorized-row rejection.
3. Add execution-time trust revalidation before side effects.
4. Add database and queue regression tests.

### Phase 2: Slack authorization test seams

1. Extract the inbound message handler with injected dependencies.
2. Add trusted/untrusted message tests.
3. Capture slash-command and action callbacks with a fake App.
4. Add trusted/untrusted command and action tests.
5. Add setup/startup trust tests.

### Phase 3: Hard rename

1. Rename package-facing metadata and binary.
2. Rename runtime paths and product-specific environment variables.
3. Rename daemon and Slack-facing identities.
4. Update agent prompts and all code messages.
5. Update the local Git remote.
6. Run repository-wide stale-name searches.

### Phase 4: First-release cleanup

1. Set version `0.1.0`.
2. Rewrite the changelog as a first release.
3. Delete stale plan/research documents.
4. Normalize README, contributing docs, templates, and manifest.

### Phase 5: Baseline schema and strict inputs

1. Establish schema version 1.
2. Remove legacy column migrations and tests.
3. Add strict shared Slack ID validation.
4. Tighten every CLI command parser.
5. Add malformed-input tests.

### Phase 6: Configuration and tooling hygiene

1. Add uniform dotenv quoting and round-trip tests.
2. Verify setup mode `0600` for new and existing files.
3. Fix `.prettierignore` lockfile ownership.
4. Silence Vitest logging.

### Phase 7: Release verification

Run the complete quality gate and inspect the resulting package.

---

## 13. Final verification checklist

### Automated checks

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

### Security checks

- Untrusted messages never enqueue or invoke pi.
- Revoked queued messages cannot execute after restart.
- Scheduler messages still execute.
- Untrusted slash commands and actions are acknowledged and otherwise silent.
- Final trusted-user removal is refused.
- Generated token config has mode `0600`.

### Naming checks

- Package is `@stayradiated/pi-tag-slack@0.1.0`.
- Only the `pi-tag-slack` binary is packaged.
- Repository links point to `stayradiated/pi-tag-slack`.
- Runtime paths and service names use `pi-tag-slack`.
- Product-specific environment variables use `PI_TAG_SLACK_...`.
- Slack manifest uses the final product identity while retaining `/pi` as the slash command.
- No compatibility alias or migration logic for old names remains.

### Repository checks

- `PLAN.md` is absent.
- `docs/RESEARCH.md` is absent.
- `pnpm-lock.yaml` is the only lockfile.
- Formatting passes.
- Test output is quiet.
- Packed contents include only intended runtime files and documentation.
- Git status contains only intentional changes.

## Definition of done

The refactor is complete when the repository has one consistent `pi-tag-slack` identity, authorization is enforced at ingestion and execution, all trust boundaries have direct tests, the database has a clean version-1 baseline, every CLI command rejects malformed input consistently, generated configuration round-trips safely with mode `0600`, all quality gates pass, and the package is ready to tag and publish as `v0.1.0`.
