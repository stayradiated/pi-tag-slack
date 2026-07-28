# Single-conversation gateway: engineering completion plan

## Status

**Automated gate complete; manual release validation remains.** The hard-cut single-conversation architecture and its automatable operational cleanup are implemented. The unchecked live Slack, systemd, and launchd gates still block release sign-off.

Verified against the current tree in July 2026:

- `pnpm install --frozen-lockfile`: passed
- `pnpm audit --prod`: no known vulnerabilities
- `pnpm format:check`: passed
- `pnpm lint`: passed
- `pnpm test`: 213 passed, 1 skipped
- `pnpm build`: passed

Passing automated checks do not establish completion of the unchecked manual platform and Slack validation below.

## Goal

Run one daemon that owns:

- exactly one configured public or private Slack conversation;
- exactly one persistent pi RPC session;
- one SQLite database and one Unix control socket;
- durable Slack inbox items, tasks, schedules, trust, and event deduplication.

Slack supplies work. Pi decides what action is needed and uses the ordinary `pi-tag-slack` CLI to inspect, communicate, and resolve it. Pi's ordinary assistant output is never posted to Slack automatically.

This remains an alpha hard cut. Do not migrate the legacy queue schema or restore multi-channel, DM, slash-command, App Home, or interactive Slack behavior.

## Current implementation

The following foundation exists and should be preserved unless a release-blocking fix requires changing it:

- Canonical path derivation from `PI_TAG_SLACK_CONFIG` and `PI_TAG_SLACK_DATA_DIR`.
- Private structural directories/files and an OS-held non-blocking `flock` gateway lock.
- Schema version 2 with the six intended `STRICT` tables and canonical schema-definition checks.
- WAL, `synchronous=FULL`, foreign keys, busy timeout, and `trusted_schema=OFF` setup.
- Typed singleton configuration and allowlisted runtime updates.
- Transactional Slack event-ledger/inbox create, edit, deletion, and deduplication.
- Inbox, task, schedule, trust, session, archive, config, and live Slack CLI routes.
- One Bolt Socket Mode client restricted to the configured conversation.
- Live Slack history/message/thread/send, file download, and V2 upload support.
- Persistent pi RPC startup handshake, desired/effective model and thinking state, restart backoff, and bounded shutdown.
- Startup schedule materialization and one aggregate recovery prompt.
- Idle and confirmed active session-reset plumbing with archive creation.
- Managed reaction reconciliation.
- Strict control-socket request/response framing, client validation, deadlines, and response correlation.
- Journaled setup/reset, backup bundles, interrupted-reset recovery, offline doctor, service lifecycle commands, and structured logging.
- A manifest without slash commands, interactivity, App Home, DMs/MPIMs, or `app_mention`.

## Product invariants

Treat these as non-negotiable acceptance criteria.

### Conversation and trust

- Setup selects one raw `C...` or `G...` conversation ID.
- Slack metadata, not the ID prefix alone, must prove it is a public or private channel rather than a DM or MPIM.
- The bot must already be a member.
- Every new top-level message and every new thread reply must contain a real raw `<@BOT_ID>` mention.
- Edits and deletions of an accepted open message do not need another mention.
- Trust is checked only when an event enters the gateway.
- Untrusted or unattributable events are acknowledged and ignored without persistence or Slack side effects.
- Removing trust affects only future events. An empty trust list is valid.

### Durable ingestion

- Use the top-level Events API `event_id`, stored as `slack:event:<event_id>`, as the only delivery identity.
- Never substitute a Socket Mode envelope ID, message timestamp, thread timestamp, or SQLite ID.
- A relevant event is acknowledged only after its SQLite transaction commits.
- Ignored events may be acknowledged immediately after local validation.
- Event-ledger insertion and inbox mutation occur in one transaction.
- Duplicate events perform no inbox mutation, reaction, enrichment, attachment work, or pi notification.
- A distinct new-message event for an already represented Slack message is ledgered as a no-op and does not notify pi.
- Unknown or resolved-message edits/deletions are ignored without ledger insertion.
- Missing/invalid top-level event IDs are rejected without inventing a fallback.
- Resolved inbox source snapshots are immutable under later upstream edits/deletions.

### Pi execution and recovery

- Start the configured executable as:

  ```text
  pi --mode rpc --session-dir <data-dir>/sessions/session --continue --approve
  ```

- Require pi `>= 0.82.0` and validate the RPC capability handshake at setup and startup.
- Use strict LF-delimited UTF-8 JSONL with command correlation and bounded frames.
- Set follow-up mode to `one-at-a-time`.
- Send `prompt` while idle and `follow_up` while active.
- Serialize Slack admission/notification, task notification, scheduler work, trust changes, session setting changes, and session reset through one daemon coordinator where ordering matters.
- Record RPC acceptance metadata only after a successful correlated RPC response.
- Ordinary assistant output stays session-local.
- Daemon startup and explicit session reset send at most one neutral summary of durable open work.
- Automatic pi child restart sends no recovery prompt.
- Do not automatically re-wake pi merely because work remains unresolved.
- On exhausted restart attempts, new durable work may open one fresh start window and presents only that new work while noting other work may exist.

### Lifecycle

Inbox and tasks support only:

```text
open -> resolved
```

There is no reopen operation. Resolution reason is arbitrary diagnostic text and must never control behavior.

Schedules support:

- one-time `--at` values with `Z` or an explicit UTC offset;
- five-field cron plus an explicit IANA timezone;
- atomic task creation and schedule advancement;
- unique occurrence keys;
- one coalesced catch-up task per recurring schedule after downtime;
- no accumulation while disabled.

### Local authorization

The daemon OS account is the authorization boundary:

- data directory mode `0700`;
- bootstrap config, database, lock, and reset journal mode `0600`;
- control socket mode `0600`;
- no claimed peer-credential or root exclusion;
- no special agent-origin capability.

Pi and a local operator running as the daemon account have equal CLI authority.

## Release-blocking work

Work in this order. Do not add unrelated product surface until sections 1–5 are complete.

### 1. Fix Socket Mode acknowledgement ordering

**Problem:** `src/slack.ts` uses Bolt's `app.event()` API. Bolt acknowledges ordinary Events API requests before invoking the listener. The callback then passes a no-op acknowledgement to `processSlackEvent()`. A process crash can therefore lose an acknowledged event before SQLite commit.

Required change:

- Replace or bypass the high-level auto-ack path so the gateway owns the Socket Mode envelope acknowledgement.
- Preserve one Socket Mode connection and the existing local admission rules.
- For ignored deliveries, acknowledge after local validation and before any network/enrichment work.
- For relevant deliveries, commit event-ledger/inbox state first, then acknowledge, then run reaction/pi side effects.
- If SQLite admission fails, do not acknowledge; allow Slack retry.
- Keep the pre-ack path free of Slack Web API calls.
- Ensure shutdown drains already accepted admission work without accepting new envelopes indefinitely.

Acceptance tests:

- [x] A real top-level Events API fixture reaches SQLite before the captured acknowledgement callback.
- [x] Injected SQLite failure produces no acknowledgement and no post-commit side effect.
- [x] Duplicate delivery is acknowledged but causes no second notification/reaction.
- [x] Ignored bot/untrusted/channel-mismatch/missing-mention events acknowledge without persistence.
- [x] New/edit/delete public and private channel fixtures use top-level `event_id`.
- [x] Restart and concurrent duplicate tests prove one inbox mutation and one notification.

### 2. Repair reaction reconciliation

**Problem:** reconciliation removes `reaction_actual`, adds `reaction_desired`, and persists only after both calls succeed. If removal succeeds and addition fails, SQLite still claims the removed reaction exists; retries can fail forever with Slack `no_reaction`.

Required change:

- Make each confirmed Slack transition durable independently, or treat `no_reaction` as successful absence.
- Preserve user-managed reactions; only remove the bot's own managed reaction.
- Revert open `⏳` items to `👀` after pi crash and explicit session reset.
- Keep desired state and retry diagnostics durable. In-memory attempt counters may supplement, but must not be the only durable retry state needed after restart.
- Confirmed source deletion clears desired/actual managed reaction state.
- A response removes managed reactions; silent resolution requests `✅`.

Acceptance tests:

- [x] Removal succeeds/addition fails/retry eventually adds the desired reaction.
- [x] `no_reaction` is handled idempotently.
- [x] `👀 -> ⏳`, response cleanup, and silent-resolution `✅` work.
- [x] Pi crash and session reset revert open `⏳` items to `👀`.
- [x] User reactions are not removed.
- [x] Restart preserves enough retry state to continue reconciliation.
- [x] Deleted-source handling converges without repeated retries.

### 3. Harden persistent pi RPC transport

Required change:

- Drain and safely log/bound child stderr so the pipe cannot block pi.
- Add a maximum incomplete buffer size and maximum complete frame size.
- Kill/degrade the child on oversized, malformed UTF-8, malformed JSON, or invalid protocol frames.
- Runtime-validate every correlated response, including prompt/follow-up responses, rather than accepting any same-ID frame with `success: true`.
- Add bounded per-command handling so a child that stays alive but never responds cannot retain pending commands forever.
- Ensure child exit/error rejects every pending command exactly once.
- Preserve bounded stdin-close, TERM, and KILL shutdown escalation.
- Keep automatic restart idle and retain the existing capped backoff/failure threshold behavior.

Acceptance tests:

- [x] Large stderr output cannot stall command responses.
- [x] Oversized unterminated and terminated frames degrade/restart the session without unbounded allocation.
- [x] Unicode line separators do not split frames; invalid UTF-8 is fatal.
- [x] Wrong-command and malformed same-ID responses are rejected.
- [x] Nonresponding commands time out and do not leak pending entries.
- [x] Exit/error races reject pending work once and schedule at most one restart.
- [x] Automatic restart sends no prompt; exhausted-window new work behavior remains correct.

### 4. Close coordinator, configuration, and reset races

Required change:

- Route live default model/thinking updates through the current pi catalogs before persistence.
- Apply a changed effective default immediately while idle or mark it pending while active.
- Retain desired values and mark session health degraded if later application fails.
- Do not allow `config set defaultModel/defaultThinking` to persist values unavailable from the live RPC catalogs.
- Define and enforce coordinator coverage for inbox mutations, trust changes, schedule mutations/ticks, direct task delivery, session settings, and session reset.
- Ensure `inbox.respond` cannot race source deletion/reset in a way that produces misleading lifecycle state. Preserve documented `PARTIAL_SUCCESS` and `OUTCOME_UNKNOWN` behavior for unavoidable Slack/SQLite ambiguity.
- After an active reset challenge is reserved, prevent new pi work from changing the challenged run before response flush.
- Revalidate the exact `<session-id>:<run-sequence>` at the post-flush boundary. A settled/replaced run must not be aborted using a stale confirmation.
- A failed/disconnected response flush cancels the reservation and performs no reset.
- Reset failure must leave a coherent, diagnosable session/archive state.

Acceptance tests:

- [x] Invalid live default model/thinking values leave SQLite unchanged.
- [x] Idle defaults apply immediately; active defaults apply only after `agent_settled`.
- [x] Wrong and stale reset challenges do nothing.
- [x] The successful confirmation response flushes before child termination begins.
- [x] Settlement or new-run change between reservation and flush makes confirmation stale.
- [x] Client disconnect before flush cancels reset.
- [x] Concurrent Slack delivery/task creation/reset has deterministic durable results.
- [x] Reset preserves open inbox items, tasks, schedules, cwd, and desired overrides.
- [x] Reset sends one aggregate recovery summary and updates no individual acceptance metadata.

### 5. Complete persistence and control-boundary validation

Required change:

- Add complete application validators for inbox, Slack event, task, schedule, and trusted-user rows.
- Add missing database checks for lifecycle/null coupling, timestamps, non-empty required text, JSON shape where practical, acceptance-metadata coupling, and schedule/task invariants.
- Verify required PRAGMA values after applying them.
- Keep startup's exact canonical table/index/trigger definition validation.
- Map invalid IDs, invalid state, configuration errors, expected Slack failures, and expected filesystem errors to stable public codes. Never expose SQLite statements or local sensitive paths as `INTERNAL` messages.
- Apply response-byte budgets to Slack list/message/thread results before constructing an oversized control response where practical.
- Preserve strict one-request/one-response framing, fatal UTF-8, LF termination, frame limits, deadlines, and request-ID correlation.

Acceptance tests:

- [x] Malformed rows fail startup/application reads with a safe diagnostic.
- [x] State/resolved timestamp, source deletion, JSON, schedule, and RPC metadata constraints reject inconsistent rows.
- [x] WAL/FULL/foreign-keys/busy-timeout/trusted-schema are read back and verified.
- [x] Invalid user/public IDs and expected Slack failures never become `INTERNAL`.
- [x] SQLite details and sensitive paths never cross the control boundary.
- [x] Slack response budgeting returns `RESPONSE_TOO_LARGE` predictably.
- [x] Partial, oversized, malformed, second-frame, EOF-before-LF, idle-timeout, and correlation tests remain green.

## Operational completion

### Setup, reset, and filesystem safety

The journaled implementation exists, but it needs adversarial validation before release.

- [x] Validate every existing structural ancestor for safe ownership/type/mode without following symlinks.
- [x] Reopen staged and installed config/database/session artifacts and verify exact bootstrap values and modes.
- [x] Run `quick_check` for staged/reset/offline-doctor databases, not ordinary startup.
- [x] Verify required PRAGMAs on staged and installed databases.
- [x] Add failure injection after every destructive rename, write, and fsync boundary.
- [x] Test reset with the latest committed row resident only in WAL.
- [x] Test WAL/SHM rollback, cleanup, and incomplete sidecar combinations.
- [x] Prove backup bundle collisions never overwrite and manifests/hashes detect tampering.
- [x] Prove interrupted reset recovery always restores from validated journal/bundle state and never guesses a roll-forward.
- [x] Ensure no partial success message or daemon install/start occurs after failed installation.

### Doctor and daemon lifecycle

- [x] Keep online doctor database/session inspection control-socket-only.
- [x] Keep offline doctor lock-gated and source-state read-only, including WAL-resident commits in its disposable snapshot.
- [x] Report every canonical path with owner, mode, type, and symlink diagnostics.
- [x] Surface degraded pi and control-server runtime errors in doctor/session/daemon status.
- [x] Decide and document log rotation/retention behavior or explicitly defer it for alpha.
- [ ] Run Linux systemd user-service install/start/status/log/stop/uninstall smoke tests.
- [ ] Run macOS launchd install/start/status/log/stop/uninstall smoke tests.
- [x] Verify bounded ordered shutdown with active Slack, control, scheduler, coordinator, and pi work.

### Dependency and documentation cleanup

- [x] Fix formatting and keep format/lint/test/build green.
- [x] Remove dependencies proven obsolete after implementation settles.
- [x] Keep exact-pinned Pi packages development-only for types; the configured executable is the sole runtime integration.
- [x] Re-audit README, `.env.example`, changelog, manifest instructions, service reinstall instructions, and prompt examples against the final CLI.
- [x] Document that project/user pi extensions requiring interactive UI may block in RPC/headless mode.
- [x] Document same-UID upload TOCTOU limits and the trusted Slack user's ability to influence an agent with daemon-account capabilities.

## Required public CLI

Runtime commands use the daemon control socket and never open SQLite or create another Slack client:

```text
pi-tag-slack inbox list [--state <open|resolved|all>] [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack inbox show <inbox-id> [--json]
pi-tag-slack inbox respond <inbox-id> --text <text> [--file <path> ...]
pi-tag-slack inbox resolve <inbox-id> [<inbox-id> ...] [--reason <text>]
pi-tag-slack inbox working <inbox-id>

pi-tag-slack slack history [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack slack message <message-ts> [--json]
pi-tag-slack slack thread <thread-ts> [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack slack file download <file-id> [--json]
pi-tag-slack slack send [--thread <thread-ts>] --text <text> [--file <path> ...]

pi-tag-slack task add --title <text> --instructions <text>
pi-tag-slack task list [--state <open|resolved|all>] [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack task show <task-id> [--json]
pi-tag-slack task resolve <task-id> [<task-id> ...] [--reason <text>]

pi-tag-slack schedule add --title <text> --instructions <text> --at <ISO-8601-with-Z-or-offset>
pi-tag-slack schedule add --title <text> --instructions <text> --cron <five-field> --timezone <IANA>
pi-tag-slack schedule list [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack schedule show <schedule-id> [--json]
pi-tag-slack schedule enable|disable|remove <schedule-id>

pi-tag-slack trust list [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack trust add <U...|W...>
pi-tag-slack trust remove <U...|W...>

pi-tag-slack config show [--json]
pi-tag-slack config set <key> <value>
pi-tag-slack config reset <key>

pi-tag-slack session status [--json]
pi-tag-slack session reset [--confirm <session-id>:<run-sequence>]
pi-tag-slack session model list [--json]
pi-tag-slack session model set <provider/model>
pi-tag-slack session model reset
pi-tag-slack session thinking set <off|minimal|low|medium|high|xhigh|max>
pi-tag-slack session thinking reset
pi-tag-slack session archive list [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack session archive cleanup
```

Local/offline commands:

```text
pi-tag-slack setup [--reset] [--yes] [--channel <C...|G...> --cwd <path> --model <provider/model> --trusted-user <U...|W...>] [--pi-bin <path>] [--thinking <level>] [--bot-token <xoxb-...> --app-token <xapp-...>]
pi-tag-slack daemon install|uninstall|start|stop|status|logs
pi-tag-slack doctor
pi-tag-slack help
```

Do not add a channel option, thread-reply command, inbox reopen, session stop/new, slash command, or special agent-only command.

## Output and error contract

- Public IDs are `inbox-N`, `task-N`, and `schedule-N`.
- Gateway timestamps are UTC ISO 8601 with milliseconds; Slack timestamps remain decimal strings.
- List defaults: open inbox/tasks, limit 50, maximum 200, deterministic newest-first ordering, opaque cursors, and visible `nextCursor`.
- Successful `--json` output is exactly one direct JSON value on stdout.
- Failed `--json` output is exactly:

  ```json
  { "error": { "code": "...", "message": "..." } }
  ```

- Human failures are concise stderr-only messages without stack traces.
- Logs never enter command stdout.
- Slack mutation timeout/disconnect returns `OUTCOME_UNKNOWN` with the request ID and inspect-before-retry guidance; daemon work continues.
- Slack-success/SQLite-failure returns `PARTIAL_SUCCESS` and enough non-sensitive Slack identity to inspect before retrying.

## Canonical deployment layout

Only these deployment overrides are supported:

```text
PI_TAG_SLACK_CONFIG
PI_TAG_SLACK_DATA_DIR
```

All operational paths derive from the data directory:

```text
<data-dir>/gateway.db
<data-dir>/gateway.lock
<data-dir>/control.sock
<data-dir>/sessions/session/
<data-dir>/sessions/archive/
<data-dir>/media/
<data-dir>/backups/
<data-dir>/reset-journal.json
<data-dir>/daemon.stdout.log
<data-dir>/daemon.stderr.log
```

The bootstrap file contains only:

```env
SLACK_BOT_TOKEN="xoxb-..."
SLACK_APP_TOKEN="xapp-..."
```

SQLite remains the sole authority for channel, cwd, pi binary, model/thinking defaults and overrides, retention, attachment limits, scheduler batch limit, and log level.

## Final validation gate

All items are required unless explicitly moved out of scope in the changelog/release notes.

Automated:

1. [x] `pnpm install --frozen-lockfile`
2. [x] `pnpm format:check`
3. [x] `pnpm lint`
4. [x] `pnpm test`
5. [x] `pnpm build`
6. [x] Production dependency audit
7. [x] All acceptance tests in sections 1–5
8. [x] Reset failure-injection and WAL-only commit tests

Manual:

1. [ ] Linux systemd lifecycle smoke test
2. [ ] macOS launchd lifecycle smoke test
3. [ ] Public configured-channel Socket Mode smoke test
4. [ ] Private configured-channel Socket Mode smoke test
5. [ ] Mentioned text, attachment-only, edit, deletion, and mentioned thread-reply tests
6. [ ] Live history/message/thread pagination and response-bound tests
7. [ ] File download, text send, thread send, and multi-file upload tests
8. [ ] Idle prompt, active follow-up, pi crash/backoff, and no-auto-post tests
9. [ ] Active reset confirmation, disconnect, stale challenge, and recovery-summary tests
10. [ ] Interrupted reset recovery through plain `setup`

## Definition of done

The refactor is complete when:

- one canonical daemon exclusively owns one configured Slack conversation and one persistent pi session;
- Slack cannot acknowledge relevant work before durable admission;
- retries, concurrent delivery, and restart cannot duplicate inbox mutation or notification;
- pi can inspect and manage durable work and live Slack through the CLI;
- pi output reaches Slack only through explicit CLI communication;
- automatic child restart does not replay work;
- session reset is response-flushed, stale-safe, and state-preserving;
- reaction reconciliation converges after partial Slack failures and restarts;
- setup/reset is WAL-safe, journaled, recoverable, and failure-injection tested;
- control framing, errors, pagination, and response bounds meet the public contract;
- obsolete multi-channel and Slack UI behavior remains removed;
- automated and manual release gates pass.
