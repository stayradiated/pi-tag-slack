# Setup UX improvement plan

## Status

Planned. This document defines the setup changes needed before the next release. It does not authorize weakening ownership, symlink, or file-type checks at runtime.

## Goals

- Ask for the initial trusted Slack user before every other interactive setup value.
- Show Slack tokens as plaintext while they are entered.
- Repair safe, user-owned permission problems instead of terminating setup.
- Never leave the user at a silent, apparently hung prompt after input collection.
- Never install or start the daemon as a side effect of setup.
- End every successful setup or recovery with clear, manual service commands.
- Preserve setup's existing transactional guarantees: validation precedes installation, failed first-time setup leaves no active config/database, and reset remains backup-backed and recoverable.

## Explicit product decisions

1. The first interactive prompt is `Initial trusted Slack user (U... or W...)`.
2. Bot and app tokens use visible text input, not password input. They must still never be echoed later in status, progress, error, log, or success output.
3. Setup may automatically change modes only on paths that are owned by the current UID and whose file type is exactly the expected type.
4. Setup continues to reject symlinks, foreign-owned paths, non-file/non-directory substitutions, and unsafe ancestors outside the layout it owns. Those failures must identify the path and explain the manual remedy.
5. Setup does not call `daemon install`, `daemon start`, `systemctl`, or `launchctl` after installation or reset recovery.
6. Interactive and non-interactive setup print the same next-step instructions. Running `daemon install` is an explicit user action, followed by `daemon start` and optionally `daemon status`.
7. Setup-specific network validation is fail-fast and bounded. It must not inherit Slack WebClient's default no-timeout, ten-retries-over-thirty-minutes policy.

## Current problems and source locations

- `src/setup-interactive.ts` asks for the trusted user last and uses `password()` for both tokens.
- `src/cli/index.ts` emits no progress after input collection until all Pi and Slack validation has completed.
- `src/setup-validation.ts` constructs default Slack clients with unbounded request timeout and the SDK's long retry policy.
- `src/pi-rpc.ts` bounds RPC commands but does not bound `pi --version`.
- `src/paths.ts` can reject a user-owned, repairable managed directory before `assertOwnedPrivate()` reaches its `chmod`.
- `src/config.ts` rejects an existing config with a repairable mode before `ensurePrivateFile()` can repair it.
- `src/paths.ts` rejects an existing same-UID lock file with the wrong mode instead of repairing it.
- `setupSuccess()` in `src/cli/index.ts` installs and starts the daemon in interactive mode.
- `README.md` currently promises that interactive setup installs and starts the service.

---

## Batch 1: Prompt order and visible input

### 1.1 Reorder interactive collection

Update `collectInteractiveSetup()` in `src/setup-interactive.ts` to collect values in this order:

1. Initial trusted Slack user.
2. Slack conversation/channel ID.
3. Working directory.
4. Pi binary.
5. Default model.
6. Default thinking level.
7. Slack bot token.
8. Slack app token.

Keep the returned `InteractiveSetupValues` shape named rather than positional so reordering prompts cannot reorder setup arguments accidentally.

Cancellation at every prompt must continue to return without creating database/config state or invoking service management.

### 1.2 Make token entry visible

- Replace both token `password()` calls with `text()` calls.
- Remove `password` from `SetupPrompts` if it has no remaining use.
- Do not place token values in prompt labels, validation progress, thrown errors, snapshots, logs, or test failure messages.
- Keep config persistence unchanged: tokens remain plaintext dotenv values in a `0600` bootstrap config.

### 1.3 Tests

Update `test/setup-interactive.test.ts` to prove:

- the trusted-user prompt is first;
- both token prompts use visible text input;
- values are forwarded to the correct named flags despite the new order;
- cancellation at the first prompt and at each token prompt leaves no active setup artifacts;
- no output contains either supplied token.

Prefer a recording prompt fake that captures method, message, and order rather than a single undifferentiated value queue.

### Batch 1 completion criteria

- A manual interactive run visibly asks for the trusted user first.
- Both complete tokens remain visible while typing.
- Prompt-order tests fail if any value is accidentally mapped to the wrong setup flag.

---

## Batch 2: Safe permission repair

### 2.1 Separate repairable paths from unsafe structures

Refactor the path checks in `src/paths.ts` and `src/config.ts` around two outcomes:

**Automatically repair:**

- same-UID managed directories with the expected directory type but a mode other than `0700`;
- same-UID managed regular files (database, bootstrap config, lock, journal, and setup staging files where applicable) with a mode other than `0600`;
- the immediate default application config directory when it is same-UID and a real directory.

**Always reject:**

- any symlink in a structural path;
- foreign-owned managed paths;
- regular files where a directory is expected or directories/devices/sockets where a regular file is expected;
- an unsafe unmanaged ancestor where setup cannot safely claim ownership or change policy;
- a live/contended lock, regardless of its path mode.

Do not recursively chmod arbitrary parents such as `$HOME`, `~/.config`, a custom data-dir parent, or a custom config parent. If one of those ancestors is genuinely unsafe, fail with the exact path, observed condition, and a suggested `chmod`/path relocation remedy.

### 2.2 Repair before strict mode validation

- For managed layout entries, inspect ownership/type without following links, repair the mode, then verify the result.
- For an existing bootstrap config, perform the same-UID regular-file repair before the strict bootstrap read validation.
- For an existing lock, verify identity/ownership/type, repair to `0600`, reopen with `O_NOFOLLOW`, verify inode identity, and only then attempt the non-blocking flock.
- Wrap failed chmod operations with an actionable setup error rather than exposing an unexplained filesystem exception.

Maintain the existing no-follow and inode-identity protections. Permission repair must not introduce a check/use symlink race.

### 2.3 Report repairs

Interactive setup should emit a concise status such as:

```text
Repaired permissions: /path/to/pi-tag-slack (0700)
```

Do not print a message when no change was needed. Non-interactive setup may emit the same stable line to stderr or through the normal setup status reporter.

### 2.4 Tests

Extend `test/gateway-foundation.test.ts`, `test/gateway-lock.test.ts`, and setup tests to cover:

- repairing an owned data directory from `0755` and `0770` to `0700`;
- repairing nested managed directories;
- repairing an owned config, database, and lock file from `0644` to `0600`;
- successful setup after each repair;
- refusing symlinks, wrong types, foreign owners, and unsafe unmanaged ancestors;
- preserving lock contention semantics after mode repair;
- reporting repaired paths without disclosing tokens;
- leaving doctor read-only: `doctor` should diagnose rather than silently chmod.

### Batch 2 completion criteria

- Every wrong-mode, same-UID managed path used by setup is repaired when chmod is possible.
- Security-boundary failures remain refusals and provide an actionable path-specific message.
- Runtime and offline doctor behavior is not silently broadened.

---

## Batch 3: Observable, bounded validation

### 3.1 Add setup progress reporting

Introduce a setup progress interface rather than scattering direct terminal calls through validation. It should support at least `start(label)`, `success(label)`, and `failure(label)` and have stable non-TTY output.

Report these stages after the final prompt:

1. Checking local paths and acquiring the setup lock.
2. Validating the Pi executable and version.
3. Starting the temporary Pi RPC session.
4. Validating model and thinking settings.
5. Validating the Slack bot token.
6. Validating the Slack app token and Socket Mode permission.
7. Validating conversation access and membership.
8. Validating the initial trusted user.
9. Writing and verifying staged state.
10. Installing setup state.

A stage failure must leave its label visible before the normal sanitized error. Progress output must never include tokens or Slack API response bodies.

### 3.2 Bound Pi validation

- Add an explicit timeout to `execFile(binary, ['--version'])`; target 10 seconds for setup.
- Allow setup to configure a shorter RPC command timeout than the long-lived daemon if necessary.
- Bound the complete temporary Pi validation operation and guarantee the child is stopped/killed and its temporary session directory removed on timeout.
- Preserve the detailed local error indicating whether version, startup, model, or thinking validation failed.

### 3.3 Bound Slack validation

Construct setup-only `WebClient` instances with:

- a 10-second request timeout;
- no automatic long retry policy during interactive setup;
- rate-limit and transport failures returned immediately with a concise retryable setup error.

The four Slack checks are deliberately sequential so progress identifies the failing credential/resource. Each check must settle within its configured request deadline; the full healthy path should normally complete in seconds and the worst-case path should fail in under one minute.

Do not change the daemon's runtime Slack retry behavior as part of this batch.

### 3.4 Tests

Extend `test/setup-validation.test.ts` and `test/setup-interactive.test.ts` to prove:

- progress stages occur in the documented order;
- a never-returning Pi version check times out and cleans up;
- a silent Pi RPC command times out and cleans up;
- each never-returning Slack check is bounded and identifies its stage;
- validation failure creates no active config/database state;
- token values never occur in progress or errors;
- healthy validation still reaches staging exactly once.

Use fake timers and injected clients/process seams; do not add live Slack calls to the automated suite.

### Batch 3 completion criteria

- After entering the trusted user and remaining values, the terminal immediately explains what setup is doing.
- No setup validation can inherit an infinite request timeout or a thirty-minute retry policy.
- Timeout cleanup leaves no Pi child, temporary session directory, staged file, or held gateway lock.

---

## Batch 4: Remove automatic daemon management

### 4.1 Make setup service-free

Update `src/cli/index.ts`:

- Remove `installAndStartDaemon` from `SetupDependencies`.
- Replace `setupSuccess(interactive, dependencies)` with a service-free completion presenter.
- Ensure first-time setup, reset, and interrupted-reset recovery all use the same completion path.
- Do not call `daemon()` from any setup branch.
- Keep daemon subcommands themselves unchanged.

Successful output should be explicit:

```text
Setup complete. The daemon was not installed or started.

To install the user service (first time only):
  pi-tag-slack daemon install

To start it:
  pi-tag-slack daemon start

To verify it:
  pi-tag-slack daemon status
```

If wording is centralized, tests should assert the command lines and the statement that no service action occurred rather than terminal colors or spacing.

### 4.2 Tests

Update `test/setup-interactive.test.ts` and daemon tests to prove:

- interactive first-time setup invokes no service manager;
- interactive reset invokes no service manager;
- interrupted-reset recovery invokes no service manager;
- non-interactive setup remains service-free;
- all successful variants print install/start/status instructions;
- failed or cancelled setup does not print completion instructions;
- no setup test needs an `installAndStartDaemon` fake.

### Batch 4 completion criteria

- There is no call path from `setup` to `daemon`, `systemctl`, or `launchctl`.
- Setup returning success means only that configuration/database installation succeeded.
- The user receives exact commands to explicitly install, start, and check the daemon.

---

## Batch 5: Documentation and release notes

Update:

- `README.md`: prompt behavior, visible token warning, validation progress/deadlines, permission repair policy, and manual daemon lifecycle.
- `CHANGELOG.md`: note the setup UX changes and removal of automatic service installation/start.
- `.env.example` if its comments imply hidden input or automatic service startup.
- CLI help if setup's interactive/manual-service behavior needs a short clarification.

Document that visible token entry is an intentional local-terminal tradeoff: tokens remain out of command-line arguments and shell history, but are visible to screen observers and terminal recording software.

## Implementation order

Implement batches in this order:

1. Prompt order and visible tokens.
2. Permission repair.
3. Progress and bounded validation.
4. Service-free completion.
5. Documentation and release notes.

Batch 4 may be implemented earlier if desired, but it must land with its tests and README correction in the same change.

## Final verification

Automated gate:

```text
pnpm format:check
pnpm lint
pnpm test
pnpm build
node dist/cli/index.js help
```

Manual isolated-path matrix using temporary `PI_TAG_SLACK_DATA_DIR` and `PI_TAG_SLACK_CONFIG` values:

- [ ] Fresh interactive setup asks for the trusted user first.
- [ ] Both tokens are visible while typing and absent from subsequent output.
- [ ] Healthy post-input validation continuously reports progress.
- [ ] Disconnected Slack validation fails within the documented bound.
- [ ] A stalled Pi executable fails within the documented bound and leaves no child.
- [ ] Owned wrong-mode managed paths are repaired and setup succeeds.
- [ ] Symlink, foreign-owner, and wrong-type fixtures remain rejected.
- [ ] Successful setup does not install or start a service.
- [ ] The printed install/start/status commands work when run manually.
- [ ] Reset and interrupted-reset recovery remain backup-safe and service-free.

## Done when

The setup flow is observable, bounded, and recoverable; the trusted user is requested first; tokens are entered visibly; repairable same-user modes are fixed automatically; unsafe structures are still refused; and no successful setup path performs daemon lifecycle actions without a separate explicit user command.
