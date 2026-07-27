# Single-conversation, agent-directed gateway refactor plan

## Engineering handoff and implementation status

**Status: not shippable — partial gateway implementation.** The active runtime has been hard-cut away from the legacy queue implementation and now starts a persistent pi RPC child plus one configured-conversation Slack client. Treat every unchecked item in this section and every unimplemented requirement in the normative sections below as release-blocking unless it is explicitly moved out of scope.

This status was verified against the working tree containing `src/config.ts`, `src/paths.ts`, `src/db.ts`, `src/scheduler.ts`, `src/control.ts`, `src/index.ts`, `src/pi-rpc.ts`, `src/cli/index.ts`, `src/slack.ts`, `src/slack-client.ts`, `test/gateway-foundation.test.ts`, and `test/session-controls.test.ts`. Formatting, lint, 43 foundation tests, and the TypeScript build passed. Passing that small suite is not evidence that the product contract is complete.

Legend:

- `[x]` implemented at foundation level and covered by at least one test
- `[~]` partially implemented or implemented with correctness gaps
- `[ ]` not implemented

### What exists now

- `[x]` Canonical data-path derivation through `PI_TAG_SLACK_CONFIG` and `PI_TAG_SLACK_DATA_DIR`, plus derivation of the planned operational paths.
- `[~]` Private structural directory/file handling and an atomic lock file. Existing database symlinks, structural-path ancestor symlinks, foreign-owned data-layout paths, unsafe bootstrap files, and dangling control-socket paths are rejected during covered flows; staged setup reopens/quick-checks its database and validates its bootstrap candidate. Comprehensive parent-layout, durability, and rollback handling remain incomplete. The lock is not an OS-held lock.
- `[~]` Schema version 2 creates exactly the six planned `STRICT` tables, basic inbox/task indexes, no-reopen triggers, the configuration singleton, public IDs, and a synchronous transactional event-ledger/inbox mutation helper. Schema validation compares complete canonical table/index/trigger SQL definitions as well as structural names, but complete non-config row validators and the remaining lifecycle/timestamp/JSON constraints are incomplete.
- `[~]` WAL, `synchronous=FULL`, foreign keys, busy timeout, and `trusted_schema=OFF` are applied. They are not comprehensively read back and verified, and setup does not run the required `quick_check`/reopen validation.
- `[~]` Typed persistence exists for non-structural configuration. Session model/thinking catalog validation, persisted desired versus RPC-effective state, idle/safe-boundary application, degraded application reporting, and startup catalog validation now exist. The daemon now launches one basic persistent pi RPC child and validates the configured Slack conversation before starting its Socket Mode client, but neither integration is contract-complete.
- `[~]` The daemon owns SQLite and a Unix control server. Server-side one-request LF framing, UTF-8/JSON validation, frame bounds, timeout/EOF handling, trailing-data rejection, request-ID echoing, fixed ordinary command deadlines, and longer Slack-network deadlines exist. Slack send/inbox respond deadline expiry returns `OUTCOME_UNKNOWN` with the request ID and inspect-before-retry instruction; disconnecting clients do not cancel their daemon work. The CLI client validates bounded fatal-UTF-8 single-frame responses, response schema, correlation ID, and uses the same command classes. Dedicated deadline/disconnect regression coverage remains incomplete.
- `[~]` Minimal JSON-only commands exist for inbox list/show/resolve, task add/list/show/resolve, trust add/list/remove, config show/set/reset, and live Slack history/message/thread/send. Runtime `task add` now durably inserts before notifying the daemon-owned pi session, records direct RPC acceptance only after success, and reports notification failures as non-retryable partial success containing the created task ID. Slack list cursors are passed through and common live-Slack failures have basic stable codes. This is not the complete CLI contract; human output, JSON error envelopes, trust validation/pagination, response-size bounds, and comprehensive error mapping are incomplete.
- `[~]` A simple non-interactive first-time setup stages a database and bootstrap token file. It does not perform the required pi/Slack validation, durable staging validation, reset, backup, journal, rollback, or recovery flows.
- `[x]` The manifest removes slash commands, interactivity, App Home, DM/MPIM events/scopes, and `app_mention`, and retains `message.channels` and `message.groups`.
- `[~]` Forty-three foundation tests cover selected schema rejection, database-symlink rejection, sequential event deduplication, no-reopen behavior, limited server framing/ID echoing, task pagination and direct pi delivery/failure metadata, startup recovery summary construction, typed configuration, configured-conversation Slack history/thread/message/send behavior, fake-child RPC session/health snapshots, and desired/effective model/thinking controls. Most tests specified later in this document do not exist.

### Correctness work required before building on the foundation

Complete these first so later Slack and RPC work does not depend on unsafe or misleading primitives:

- [~] Validate the bootstrap config path before reading it. Runtime loading now rejects unsafe existing files and immediate parents and avoids import-time reads, but setup staging/reopen validation and comprehensive parent-layout checks remain incomplete.
- [~] Make `doctor` read-only apart from the unavoidable held lock. It now queries daemon control health, including the live session snapshot, when online and does not create the layout offline, but offline SQLite read-only inspection remains incomplete.
- [ ] Replace the atomic PID file with the specified portable OS-held exclusive lock. Until then, at minimum ensure every failure after lock creation closes the descriptor and removes the partial lock without deleting a replacement path.
- [x] Harden control-socket startup and shutdown: `lstat` rejects dangling symlinks, non-socket paths, and foreign-owned sockets; the bound socket dev/ino identity is captured after listen; an idempotent owned-server `close()` closes the listener and unlinks only that identity while preserving replacements. Post-bind failures use the same cleanup path, and runtime server errors are retained/reported rather than becoming unhandled events.
- [x] Implement client-side response byte limits, fatal UTF-8 decoding, exactly-one-LF-frame validation, response schema validation, and request-ID correlation.
- [~] Introduce and test a stable error-code mapping. Live Slack navigation/send now maps unavailable clients, missing messages, and common Slack failures to `SLACK_UNAVAILABLE`, `NOT_FOUND`, and `SLACK_ERROR`; invalid live-Slack parameters use `INVALID_PARAMS`. Invalid IDs/config/users must not become `INTERNAL`, and internal SQLite details must not leak as public errors.
- [x] CLI failures now emit exactly one `{ "error": { "code", "message" } }` JSON value and exit nonzero for `--json`; human-mode failures are concise stderr messages without stack traces. Daemon errors remain sanitized at the control boundary.
- [~] Validate complete schema definitions or otherwise make malformed same-name constraints, indexes, triggers, and foreign keys fail startup. Canonical SQL definitions are now checked; add complete row validators and the missing lifecycle/timestamp/JSON constraints.
- [x] Make `trust add` call daemon-owned Slack `users.info` to validate and cosmetically label the user before commit; invalid IDs are rejected locally, failed lookup leaves SQLite unchanged, and trust mutations share the gateway coordinator.
- [~] Reopen and validate staged setup artifacts, run `quick_check`, verify exact bootstrap values/modes, and validate parent ownership before installation. The staged DB/config checks now exist; complete parent ownership and durability validation.
- [x] Return `tsconfig.json` to a directory-level source include, or enforce another mechanism that cannot silently omit newly added production modules.
- [ ] Remove dependencies that are truly obsolete after the implementation settles; keep exact-pinned Pi packages as development-only type dependencies.

### Remaining product implementation

#### Slack gateway

- [~] Start one Socket Mode Slack client and parse real top-level Events API message bodies. The runtime obtains the bot ID with `auth.test`, validates configured-conversation access/type/membership with `conversations.info`, starts Bolt Socket Mode, and serializes deliveries. Reconnect/health handling and live integration tests remain absent.
- [~] Basic local admission validates message subtype/bot authorship, configured conversation, an event-provided public/private conversation type, trusted sender, top-level `event_id`, and raw bot mention before durable insertion. Startup verifies bot membership, but not all real Slack payload variants; the exact normative ordering/coverage needs further tests.
- [~] The existing transactional event ledger/inbox create, edit, deletion, duplicate, and ignored-mutation behavior is now invoked by Socket Mode. Focused admission tests cover post-ack pi notification ordering, duplicate suppression, and untrusted ignore behavior; restart/concurrency and live-delivery tests remain absent.
- [~] Ingestion stores a reduced file metadata snapshot without downloading, strips exact raw bot mentions from new-message text, and accepts `file_share` attachment-only messages. Attachment schema/validation and complete Slack file payload handling remain incomplete.
- [~] Relevant events are acknowledged after SQLite admission and then notify pi; ignored events are acknowledged without persistence. Newly created items also attempt a post-commit `👀` reaction and retain actual/error diagnostics. Broader post-commit enrichment, reaction retries/backoff/reconciliation, lifecycle cleanup, and tests remain unimplemented.
- [~] Implement live history/message/thread navigation, configured-conversation enforcement, pagination, response bounds, send/reply behavior, and outcome-unknown handling. `slack history`, `slack message`, `slack thread`, and `slack send [--thread]` now use only the daemon-owned configured-conversation client; history/thread pass Slack cursors through and return `{ items, nextCursor }`, while lookup returns the exact requested timestamp or `NOT_FOUND`. Timed-out `slack send` reports `OUTCOME_UNKNOWN` plus its request ID and an inspect-before-retry instruction; no mutation is automatically retried and the daemon call continues after client departure. Explicit Slack response-byte budgeting, exhaustive error classification, refined human formatting, and regression coverage remain.
- [~] Implement on-demand download and upload with file ownership, type, symlink, size, sanitization, and re-stat checks. `slack file download <F...>` validates live metadata/share ownership and atomically stores bounded streamed content under `media/`. `slack send` and `inbox respond` now share local regular-file validation, per-file/aggregate limits, pre-upload identity/size re-stat checks, and Slack V2 uploads restricted to the configured conversation/thread; control messages carry paths and results only. Deadline/outcome-unknown handling remains unimplemented.

#### Persistent pi RPC session

- [~] Launch the configured pi binary in persistent RPC mode with the canonical session directory and configured working directory. Daemon startup materializes due schedule tasks before pi starts, then sends at most one neutral aggregate recovery summary when durable open inbox/tasks exist; it includes totals and up to three newest rows of each kind and does not alter individual acceptance metadata. Session-reset recovery, coalesced scheduler catch-up, and process supervision/restart policy are not implemented.
- [x] Before spawning RPC, run `<pi-binary> --version`, require a parseable version of at least `0.82.0` matching the pinned development dependency, then runtime-validate the `set_follow_up_mode`, `get_state`, model-catalog, and thinking-level handshake. Startup rejects unavailable/old/malformed executables, malformed or unsupported handshake responses, and configured desired model/thinking values absent from the catalogs; focused fake-child coverage includes each failure and success.
- [~] The RPC child uses strict byte-level LF JSONL splitting, fatal UTF-8/JSON parsing, command IDs, basic `agent_start`/`agent_settled` state, runtime validation of startup state/model-catalog/thinking-level responses, read-only status snapshots, desired-state application, stdin-close shutdown, and bounded child restart supervision. Unexpected exits reject pending commands, degrade health, and restart with capped exponential backoff until the consecutive-failure threshold; successful automatic restarts remain idle, while shutdown cancels retries. Frame limits, broader response schemas, graceful escalation, and broader protocol tests remain incomplete.
- [~] RPC startup sets `one-at-a-time`; Slack deliveries, control-command task creation/direct task notification, schedule mutations/runtime ticks, startup recovery dispatch, and model/thinking mutation plus settled-boundary application are serialized by one daemon coordinator. Trust changes, reset, and other mutations are not yet included in that coordinator.
- [~] New admitted Slack work and direct manual tasks use `prompt` while idle and `follow_up` while active. Event/task RPC acceptance metadata is persisted only after a successful RPC response; task RPC failure leaves its durable task open and reports partial success without recommending a retry. Session/run identity semantics and broader failure/recovery behavior remain incomplete.
- [~] Implement neutral startup/session-reset recovery summaries and the specified no-replay behavior for automatic child restarts. Daemon-start aggregate recovery, including startup-materialized due schedule tasks, is implemented; session-reset recovery, coalesced scheduler catch-up, and child restart behavior remain.
- [~] Implement bounded restart backoff, failure thresholds, new-work retry behavior, and degraded session health. `PiRpcSession` now prevents overlapping/stale restart attempts, rejects pending RPC on unexpected exit, retries with injectable capped exponential backoff, stops at a configurable fixed threshold, clears failure state only after a validated restart handshake, and gives new work one fresh exhausted-window attempt. Fake-child/timer tests cover degradation, backoff/cap/threshold, healthy idle recovery without a prompt, pending rejection, exhausted-window reopening, and shutdown cancellation; add gateway-level tests proving durable inbox/task preservation and concurrent Slack delivery behavior.
- [ ] Ensure ordinary assistant stdout is never automatically posted to Slack.

#### Inbox, tasks, schedules, reactions, and trust

- [~] Implement basic `inbox respond` and `inbox working`. `working` durably requests `⏳`; `respond` posts to the configured conversation/source thread, resolves open items as `replied`, records extra replies on resolved non-deleted items, rejects structured deleted sources with `SOURCE_DELETED`, and reports Slack-success/SQLite-failure as `PARTIAL_SUCCESS`. Its Slack-network deadline now returns `OUTCOME_UNKNOWN` with request ID/inspect-before-retry guidance without cancelling the daemon operation, so a completed reply still records SQLite state after client disconnect. File uploads, response/reaction cleanup, and comprehensive deadline/partial-failure tests remain incomplete.
- [~] Multi-ID inbox/task resolution validates all transitions in one transaction and inbox resolution now requests `✅`. Immutable terminal-source coverage, conventional documented default reasons, reaction reconciliation, and stable-error coverage remain incomplete.
- [~] Implement the complete task repository and direct notification metadata. Manual task creation/list/show/resolve and direct notification acceptance metadata are implemented; scheduler-created task lifecycle coverage and remaining task validation are incomplete.
- [~] Implement one-time and Croner-backed recurring schedules, timezone/offset validation, occurrence keys, atomic task creation/advancement, enable/disable/remove behavior, and coalesced downtime catch-up. The first functional system now provides add/list/show/enable/disable/remove, offset-only one-time input, five-field Croner/IANA validation, unique `schedule:<id>:at:<UTC>` task keys, atomic due-task creation/advance or one-time disable, startup materialization/recovery aggregation, and runtime direct pi notification with acceptance metadata. It intentionally creates one overdue recurring occurrence and advances to the next future run; coalesced downtime catch-up (`through` keys and first/last/count), DST matrices, and failure-injection coverage remain.
- [~] Receipt insertion requests `👀`; `inbox working` requests `⏳`; silent `inbox resolve` requests `✅`; and successful receipt attempts retain actual/error diagnostics. A bounded startup/15-second reconciliation pass now replaces only the gateway's own reaction, coalesces post-transition work, and records retry eligibility with in-process exponential backoff. Response cleanup is now requested after replies through the same reconciler. Crash/reset reversion, durable retry-attempt accounting, source-deletion handling coverage, and preservation-of-user-reactions verification remain incomplete.
- [x] Complete Slack-validated trust list pagination and preserve event-time-only trust semantics, including an empty list.

#### Configuration and session controls

- [x] Implement `session status`, nested model/thinking commands, desired/effective reporting, catalog validation, and immediate-or-safe-boundary application. `session status [--json]` reports running/stopped, healthy/degraded, session ID, active/idle, run sequence, last process/protocol error, desired configuration, and RPC-exposed effective model/thinking; daemon `health` exposes that same snapshot. Model/thinking changes validate current catalogs before persistence, retain desired state on application failure, apply model before thinking while idle, and defer active changes until `agent_settled`.
- [~] Implement idle session reset using the stale-safe `<session-id>:<run-sequence>` challenge. `session reset` is coordinator-serialized; an active session returns `CONFIRMATION_REQUIRED` with the exact challenge command and makes no changes. Active confirmed reset and response-flush-before-abort mechanics remain separate.
- [~] Archive the old idle session, preserve overrides/open work/tasks/schedules, start a fresh RPC session, and send one recovery summary. Idle reset now collision-probes an archive path, creates a private fresh session directory, handshakes/reapplies desired settings, and sends the aggregate summary without per-item acceptance updates. Add dedicated filesystem/control integration coverage, archive listing/cleanup, and reset reaction handling.
- [ ] Implement archive list/cleanup while exempting reset bundles and legacy backups.

#### Setup, reset, operations, and release

- [ ] Rebuild setup as the specified interactive/non-interactive flow with pi authentication/version checks, Slack token validation, `auth.test`, conversation metadata/membership validation, cosmetic labels, trusted-user validation, and explicit trust warning.
- [ ] Implement `setup --reset`, `--yes`, typed confirmation, collision-free backup bundles, SQLite backup API/WAL handling, manifests/hashes, staging, fsync boundaries, atomic installation, rollback, and sidecar cleanup.
- [ ] Implement reset journaling, startup refusal on an incomplete journal, plain-setup recovery, deterministic restoration, and failure injection after every destructive durability boundary.
- [ ] Implement daemon install/uninstall/start/stop/status/logs for systemd and launchd, plus structured logging and graceful bounded shutdown.
- [ ] Make `doctor` report all resolved paths/owners/modes and obtain database/session/lock/socket health according to the online/offline rules.
- [ ] Update README, `.env.example`, changelog, security guidance, daemon definitions, prompt examples, manifest reapplication/reinstall instructions, and breaking-release migration steps.
- [ ] Add every test group listed in this document, then perform the complete automated and manual validation/rollout checklist before release.

The remaining sections are the normative target contract. Do not mark an item complete merely because a table, command name, or stub exists; its required validation, lifecycle, failure behavior, output contract, and tests must also exist.

## Goal

Make `pi-tag-slack` a daemon-backed gateway for exactly one explicitly configured Slack conversation and one persistent pi session.

Trusted Slack message events feed a durable inbox of Slack messages. A separate durable event ledger deduplicates new-message, edit, and deletion deliveries. Scheduled automation creates durable tasks. The daemon reliably receives, stores, filters, and presents work, while pi decides what requires action. Pi interacts with the gateway through an ordinary `pi-tag-slack` CLI rather than custom pi tools.

This is an alpha-stage hard cut. Do not migrate the legacy schema or silently adopt legacy channels, queues, tasks, or sessions.

## Product contract

- Setup explicitly selects one public (`C...`) or private (`G...`) Slack conversation. DMs and MPIMs are unsupported.
- The bot must already be a member of that conversation.
- Every new inbound Slack message must contain a real raw `<@BOT_ID>` mention. Every new thread reply must mention pi again. Edits and deletions of an existing open inbox message need not repeat the mention.
- Trusted Slack users remain a multi-user access list. Trust is checked only when a Slack event enters the system. Untrusted events are acknowledged and ignored without persistence or Slack side effects; later trust changes do not invalidate accepted events or existing inbox items. An empty trust list is valid.
- The gateway has one persistent pi RPC session, one working directory, one effective model, and one effective thinking level.
- Slack deliveries are durably deduplicated in an event ledger. The inbox stores one mutable row per open Slack message; once resolved, upstream Slack edits and deletions are ignored and the source snapshot remains immutable.
- Schedules create durable task records. Tasks are separate from the Slack inbox but are presented to the same pi session.
- Pi explicitly communicates and resolves work through the CLI. Its ordinary final stdout is never automatically posted to Slack.
- The daemon decides when pi runs; pi decides what work needs action, verification, deferral, communication, or resolution.
- Runtime commands go through the daemon. They never open SQLite independently or create a second Slack client.

## Delivery and recovery guarantees

### Slack ingestion

Slack ingestion is idempotent:

- Use Slack's top-level Events API `event_id` as the canonical delivery identity.
- Namespace the stored identity, for example `slack:event:<event_id>`.
- Do not use Socket Mode `envelope_id`, a Slack message timestamp, a thread timestamp, or a SQLite row ID as delivery identity.
- Store accepted event identities in `slack_events` under a unique constraint. Store inbox messages separately under a unique Slack message identity.
- New-message events create an inbox row. Edit events update an existing open inbox row and increment its revision. Deletion events redact an existing open inbox row and resolve it as `source-deleted`.
- Insert the event ledger row and create/update/resolve the inbox row in one transaction.
- A duplicate event performs no enrichment, reaction, notification, attachment work, inbox mutation, or second pi turn. A distinct new-message event for an already represented Slack message is recorded as a no-op and does not notify pi.
- An edit or deletion with no matching inbox row, or whose matching row is already resolved, is acknowledged and ignored without persistence. This deliberately relies on Slack's normal mutation ordering and must never crash the daemon.
- Reject and identifier-only log a relevant event that lacks a valid top-level `event_id`; do not invent a fallback identity.

One accepted Slack delivery therefore mutates inbox state at most once across concurrent delivery, Slack retries, and daemon restarts.

### Agent execution

Exactly-once agent side effects are not promised. SQLite cannot atomically commit with pi session writes, filesystem changes, arbitrary external APIs, and Slack.

Do not blindly replay interrupted Slack prompts. After daemon startup or explicit `session reset`, send a neutral recovery summary of durable open work. Automatic RPC child restarts remain idle. Pi inspects its persisted session, the inbox/task lists, and live Slack, then decides what remains necessary.

### Retention

Retain accepted `slack_events`, inbox, and task records indefinitely for the initial implementation, including resolved rows. Post-resolution or unmatched Slack mutations are ignored before acceptance and are not retained. This preserves accepted-event deduplication, history, and diagnostics without a second tombstone system. Downloaded media follows its separate retention policy.

## Canonical deployment layout

Resolve one canonical data directory. Allow only these deployment-level overrides:

```text
PI_TAG_SLACK_CONFIG
PI_TAG_SLACK_DATA_DIR
```

Derive every operational path from the data directory:

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

The bootstrap config file may live outside the data directory and contains only:

```env
SLACK_BOT_TOKEN="xoxb-..."
SLACK_APP_TOKEN="xapp-..."
```

Remove independent operational overrides such as `DB_PATH`, `SESSIONS_DIR`, `PI_MODEL`, and `PI_CWD`. SQLite is the sole authority for operational settings.

Required permissions and ownership:

- Data directory: daemon UID, mode `0700`
- Bootstrap config, SQLite database, gateway lock, and reset journal: daemon UID, mode `0600`
- Control socket: daemon UID, mode `0600`
- Session, archive, media, backup, and staging directories: private to daemon UID

`doctor` and status output include every resolved path, owner, and mode. Refuse unsafe ownership, symlink substitution at structural paths, or a data layout that cannot be made private.

## Bootstrap and persisted configuration

### Typed singleton

Use a typed `gateway_config` table with exactly one row:

```sql
id integer primary key check (id = 1)
```

Setup is the only operation that creates the row. There is no deletion API. A missing row, second row, malformed value, or incomplete configuration is fatal at startup and instructs the operator to run `setup --reset` (or plain `setup` only when no application state exists).

Use `NULL`, not empty strings, for unset optional values. Apply `CHECK` constraints and validate the complete resulting row before every update.

Persist at least:

- Configured Slack channel ID and cosmetic label
- Working directory
- Pi binary
- Default model and thinking level
- Session model and thinking overrides
- Archive and media retention
- Per-file and total attachment limits
- Scheduler batch limit
- Log level
- Created/updated timestamps

Do not store a workspace/team ID. Validate identity, channel access, and membership through Slack.

Fixed implementation constants, not settings:

- Pi concurrency: one RPC session
- Scheduler tick interval
- Shutdown timeout
- Control-protocol framing and timeout limits

### Live updates

Expose strictly typed commands:

```text
pi-tag-slack config show [--json]
pi-tag-slack config set <key> <value>
pi-tag-slack config reset <key>
```

Accept only an explicit key allowlist. Channel identity, working directory, and storage paths are structural and can change only through `setup --reset`. Arbitrary extra pi flags are unsupported; the daemon constructs the complete invariant-preserving RPC argument list.

The effective model/thinking value is `session override ?? configured default`. `session ... reset` clears the override and applies the configured default; `session reset` preserves overrides. Validate requested values against pi's current RPC catalog before persistence. Persist the desired value, apply it immediately while idle or at the next safe boundary, and report `applied` or `pending`. If later application unexpectedly fails, retain the desired value, mark session health degraded, and expose desired and effective values separately. Never mutate an in-flight model turn unexpectedly.

## Database schema and lifecycle

Create hard-cut schema version **2**. Startup rejects every legacy, version-zero application, malformed, or newer unsupported schema with an instruction to run `setup --reset`. Do not implement data migration.

The new application tables are:

1. `gateway_config`
2. `slack_events`
3. `inbox`
4. `tasks`
5. `schedules`
6. `trusted_users`

Do not retain `channels`, `message_queue`, `message_log`, or routing columns.

Define the complete schema SQL and review it before service implementation. Every application table uses SQLite `STRICT` mode. Use strict SQLite types, `INTEGER CHECK (... IN (0, 1))` booleans, `TEXT CHECK (json_valid(...))` JSON, explicit lifecycle/singleton checks, foreign keys, uniqueness constraints, and indexes. Validate complete rows in application code as well as with available SQLite checks.

Every connection enables and verifies `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, a bounded `busy_timeout`, and `trusted_schema=OFF`. Use explicit transactions for multi-row transitions. Setup/reset and offline doctor run `quick_check`; ordinary startup does not run it.

### Slack events and inbox

Each accepted `slack_events` row contains at least:

- Unique source identity (`slack:event:<event_id>`)
- Event kind (`new-message`, `edit`, or `deletion`)
- Related inbox ID and resulting inbox revision
- Outcome
- Nullable RPC acceptance timestamp, pi session ID, and run sequence
- Created timestamp

RPC acceptance metadata is diagnostic and supports recovery/reset sequencing; it is not an authorization boundary. Serialize Slack mutation, RPC dispatch, trust changes, and session reset through one daemon coordinator. Write acceptance metadata only after a successful RPC response. Accept the unavoidable crash ambiguity between RPC acceptance and the SQLite update; recovery summaries handle it without replay.

Each inbox row contains at least:

- Stable public inbox ID
- Unique Slack message identity
- Sender ID and display label
- Current message content and revision
- Slack message and root-thread timestamps
- Attachment metadata, including Slack file IDs
- Source-deletion timestamp, if deletion resolved an open item
- Lifecycle state
- Arbitrary diagnostic resolution reason and timestamps; behavior never branches on reason text
- Managed-reaction state
- Latest successful reply metadata, if any
- Created/updated timestamps

Lifecycle is intentionally only:

```text
open -> resolved
```

There is no `processing`, `failed`, `cancelled`, or `reopen` state. Cancellation, invalidity, and no-response-needed are resolution reasons. A resolved item may receive additional gateway replies but never becomes open again. Upstream Slack edits/deletions never change a resolved row's source content, attachments, revision, lifecycle, or resolution. Gateway-owned latest-reply metadata may still advance after an additional successful `inbox respond`.

`inbox resolve` accepts one or more IDs. Validate all requested transitions before committing. `--reason` is arbitrary non-empty diagnostic text with a documented default. Automatic operations use conventional text such as `replied` or `source-deleted`, but behavior never branches on these values.

### Tasks and schedules

A task is a durable unit of work with the same one-way lifecycle:

```text
open -> resolved
```

Tasks contain at least:

- Stable task ID
- Source (`manual` or `schedule`)
- Optional unique schedule-occurrence key
- Title and instructions
- Arbitrary diagnostic resolution reason
- Nullable direct-notification RPC acceptance timestamp, pi session ID, and run sequence
- Created/resolved timestamps

Schedules are definitions, not work items. When a schedule becomes due, atomically create a task with a unique occurrence identity and advance the schedule. A retried scheduler tick cannot create the same task twice.

Support exactly two schedule forms:

- One-time `--at <ISO-8601>` values, which must include `Z` or an explicit UTC offset.
- Recurring five-field `--cron <expression> --timezone <IANA-timezone>` definitions. Never use the daemon machine's local timezone; use Croner's documented timezone/DST behavior.

Schedules are not editable in this alpha. Remove and recreate one to change title, instructions, timing, or timezone. Disabling does not accumulate missed occurrences. Re-enabling a recurring schedule chooses the next future occurrence; re-enabling a one-time schedule in the past fails. When a one-time schedule creates its task, disable the schedule atomically while retaining its definition for history.

If downtime while enabled spans several recurring occurrences, create one catch-up task per schedule. Record first missed time, last missed time, and count, then advance to the next future occurrence. Use occurrence identities `schedule:<schedule-id>:at:<scheduled-UTC-time>` for ordinary/one-time work and `schedule:<schedule-id>:through:<last-missed-UTC-time>` for catch-up work. Insert the task and advance the schedule atomically. Do not flood the task list with every missed tick.

## Persistent pi RPC integration

Replace one-shot `pi -p` invocation with one daemon-owned subprocess:

```text
pi --mode rpc --session-dir <data-dir>/sessions/session --continue --approve
```

Use pi's strict LF-delimited JSONL RPC protocol. Do not parse RPC stdout with generic line readers that split Unicode line separators. Correlate commands and responses and consume lifecycle events including `agent_start`, `agent_settled`, queue updates, errors, and process exit.

RPC is preferred over embedding the SDK because it preserves process isolation, a configurable pi binary, and a clear upgrade boundary. Pi packages may remain exact-pinned development dependencies for `import type` RPC/model types only; remove them as peer/runtime dependencies and do not expose Pi types from public declarations. The configured executable is the sole runtime integration.

Document and enforce a minimum pi version matching the pinned development dependency. Setup and startup check the binary version and perform a non-destructive RPC handshake (`get_state`, model catalog, and other required state). Reject older or incompatible executables rather than adding alpha compatibility shims. Runtime-validate every RPC frame despite compile-time types. Launch with `--approve`; setup warns that project resources in the configured working directory are trusted.

Handling pi extension-UI dialog requests is explicitly out of scope for this refactor. Document that user/project extensions which request headless interaction may block; do not claim extension-UI support.

### Presenting new work

For a newly accepted Slack event:

- If pi is idle, send a normal RPC `prompt`.
- If pi is active, send the dedicated RPC `follow_up` command.
- Call `set_follow_up_mode` with `one-at-a-time` at RPC startup so Slack/task arrival order remains serial.
- Serialize prompt/follow-up writes through the daemon coordinator. Maintain active state from lifecycle events and reconcile it with `get_state.isStreaming` after startup.
- Identify event kind and inbox revision. New/edit notifications include inbox ID, sender, thread context, full current content within clear delimiters, and attachment metadata. Deletion notifications identify the now-resolved/redacted inbox item and tell pi not to continue stale work.
- Tell pi that other open work may exist and provide concise CLI guidance.

For a newly created task, use the same prompt/follow-up mechanism but identify it as a task and advertise task commands rather than inbox resolution commands. Record task RPC acceptance metadata only for direct prompt/follow-up acceptance. An aggregate recovery summary does not mark individual tasks accepted.

Durable Slack ingestion is the authorization boundary. Trust only controls which events enter the system; removing trust affects future events and never resolves, suppresses, or aborts already accepted work.

### Startup and process recovery

Start the RPC process with the daemon. Leave it idle when there is no open inbox item or task.

During daemon startup, first validate state and atomically materialize due/catch-up schedule tasks, then start RPC and send at most one recovery prompt covering both existing and newly materialized work. Do not separately notify tasks created during startup. Runtime scheduler ticks notify newly created tasks normally.

On daemon startup or explicit `session reset`, send one neutral recovery prompt rather than replaying original user prompts. An automatic RPC child-process restart after a crash never sends a recovery prompt. Show:

- Total open inbox count and the three most recent open inbox items
- Total open task count and the three most recent open tasks
- Sender/source, IDs, thread context, and safely truncated content
- Exact commands for listing and inspecting all remaining work

If pi settles or exits without resolving presented work, do not automatically wake it again. Old open work is reconsidered only when new work arrives, the daemon restarts, or the operator performs `session reset`.

If pi exits unexpectedly:

- Keep Slack and the control socket available.
- Mark session health degraded.
- Restart pi with bounded exponential backoff.
- Stop automatic attempts after a fixed consecutive-failure threshold.
- A new event/task resets the consecutive-failure attempt window and may trigger one fresh start attempt. If startup succeeds, present only that new work while noting that other open work exists; do not send a recovery summary. `session reset` and daemon restart are the other explicit retry paths.
- Preserve every inbox/task record.
- Expose the failure through `doctor`, daemon status, and session status.

Pi's ordinary assistant text remains session-local. It reaches Slack only through explicit CLI commands.

## Agent-facing CLI

All runtime commands use the daemon control socket. Read commands provide stable human output and a consistent `--json` mode.

### Inbox

```text
pi-tag-slack inbox list [--state <open|resolved|all>] [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack inbox show <inbox-id> [--json]
pi-tag-slack inbox respond <inbox-id> --text <text> [--file <path> ...]
pi-tag-slack inbox resolve <inbox-id> [<inbox-id> ...] [--reason <text>]
pi-tag-slack inbox working <inbox-id>
```

There is no `inbox reopen`. Inbox-aware operations remain in this command group because they may change durable inbox state or managed reactions.

`inbox respond <inbox-id>`:

1. Derives the source Slack thread.
2. Calls Slack.
3. On confirmed success, resolves an open item as `replied` and removes gateway-managed reactions.
4. On an already resolved item, posts an additional reply without changing lifecycle, unless structured `source_deleted_at` is set.
5. A source-deleted item rejects response with stable `SOURCE_DELETED`; behavior uses the structured field, never resolution-reason text.
6. On Slack failure, returns a clear error and leaves lifecycle unchanged.
7. If Slack succeeds but SQLite resolution fails, returns an explicit partial-success error with the Slack timestamp and tells pi to inspect before retrying.

Do not add a durable outbox. Accept the unavoidable crash ambiguity around an external Slack call; pi can inspect live Slack before deciding whether to resend. Client timeout/disconnection does not cancel an already-started Slack operation. The daemon continues and records the outcome where applicable; the CLI reports stable `OUTCOME_UNKNOWN` with its request ID and instructs the caller to inspect Slack/inbox state before retrying.

### Slack navigation and communication

```text
pi-tag-slack slack history [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack slack message <message-ts> [--json]
pi-tag-slack slack thread <thread-ts> [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack slack file download <file-id> [--json]
pi-tag-slack slack send [--thread <thread-ts>] --text <text> [--file <path> ...]
```

Every Slack command is structurally restricted to the configured conversation. There is no `--channel` option.

`slack history`, `message`, and `thread` fetch live Slack data on demand. They do not ingest or persist ambient channel history. Add explicit pagination, item limits, response-size limits, and cursors.

`slack file download` is exclusively agent/operator initiated. Ingestion stores metadata only. Before downloading, verify through Slack that the file belongs to the configured conversation, enforce configured size limits, sanitize names, and store it beneath the canonical media directory. A file deleted before download may be unavailable.

Outbound `--file` accepts any daemon-readable regular file; same-UID path restrictions are not a security boundary. Reject missing paths, directories, devices, sockets, and symlinks; enforce per-file and aggregate limits; resolve/re-stat identity and size immediately before upload; and document unavoidable same-UID TOCTOU limits.

`slack send` communicates only. With `--thread`, it replaces the former separate thread-reply command. It never changes inbox/task lifecycle or managed reactions.

### Receipt and work reactions

Reactions are visible receipt/work indicators, not queue ownership:

- After durable insertion, add `👀` to acknowledge receipt.
- `inbox working <inbox-id>` replaces `👀` with `⏳` for an open item.
- Successful `inbox respond <inbox-id>` removes all gateway-managed reactions from that source message.
- `inbox resolve` without a recorded reply replaces receipt/work reactions with `✅`.
- If pi crashes or resets, revert open items marked `⏳` to `👀` best-effort.
- Never remove user-managed reactions.
- Reaction failures do not affect inbox correctness. Retain desired state, last successful state, last attempt/error, and backoff eligibility.
- Reconcile immediately after relevant durable transitions, once at startup, and on a fixed bounded interval with backoff. A confirmed deleted source clears desired reaction state. Reconciliation never wakes pi or changes lifecycle.

### Tasks and schedules

```text
pi-tag-slack task add --title <text> --instructions <text>
pi-tag-slack task list [--state <open|resolved|all>] [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack task show <task-id> [--json]
pi-tag-slack task resolve <task-id> [<task-id> ...] [--reason <text>]

pi-tag-slack schedule add --title <text> --instructions <text> --at <ISO-8601>
pi-tag-slack schedule add --title <text> --instructions <text> --cron <five-field-expression> --timezone <IANA-timezone>
pi-tag-slack schedule list [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack schedule show <schedule-id> [--json]
pi-tag-slack schedule remove <schedule-id>
pi-tag-slack schedule enable <schedule-id>
pi-tag-slack schedule disable <schedule-id>
```

Task communication and resolution are separate. Pi uses `slack send`, optionally with `--thread`, then `task resolve`. A silent housekeeping task may be resolved without Slack output. Manual and agent invocations are intentionally indistinguishable under the same-UID authorization model, so every `task add` source is `manual`; only scheduler-created tasks use `schedule`.

### Trust

```text
pi-tag-slack trust list [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack trust add <U...|W...>
pi-tag-slack trust remove <U...|W...>
```

`trust add` validates and cosmetically labels the user through Slack before committing. An empty trust list is valid and disables all future inbound Slack admission without affecting existing work. Trust changes never mutate existing inbox/event rows or abort pi.

### Session

Retain model/thinking inspection and selection, but replace `session stop` and `session new` with one command and use consistent nested verbs:

```text
pi-tag-slack session status [--json]
pi-tag-slack session reset

pi-tag-slack session model list [--json]
pi-tag-slack session model set <ref>
pi-tag-slack session model reset

pi-tag-slack session thinking set <off|minimal|low|medium|high|xhigh|max>
pi-tag-slack session thinking reset

pi-tag-slack session archive list [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack session archive cleanup
```

`session reset`:

1. Aborts active pi work if confirmed.
2. Waits for process termination.
3. Archives the active session.
4. Starts a fresh persistent RPC session.
5. Preserves model, thinking, cwd, inbox items, tasks, and schedules.
6. Sends the normal recovery summary if open work exists.

If pi is active, the first reset attempt fails safely and prints risks plus an exact confirmation command. Confirmation is deterministic and stale-safe:

```text
pi-tag-slack session reset --confirm <session-id>:<active-run-sequence>
```

The run sequence increments for each accepted prompt/follow-up. Confirmation succeeds only while that exact session/run remains active. The socket response must be flushed before aborting pi. Local operators and pi receive the same challenge. Do not use special agent-origin behavior or automatically resolve a triggering inbox item.

## Local authorization model

Pi and the local operator have equal CLI authority. Pi already has shell access as the daemon OS account, so environment markers are not a meaningful privilege boundary.

- Authorization relies on the daemon-owned `0700` data directory and daemon-owned `0600` socket. Exact peer-credential verification is deliberately not implemented because Node lacks a portable API and native dependencies are out of scope. Root is outside the threat model.
- Do not treat inbox IDs, task IDs, thread timestamps, session IDs, or environment claims as authorization.
- Do not add a per-invocation provenance capability for special control behavior; there is no special agent-origin path.
- Advertise only workflow-relevant commands in the prompt, but do not claim unadvertised commands are inaccessible.
- Document that trusted Slack users can influence an agent running with the daemon account's local capabilities.

Future privilege separation requires a distinct OS identity or a real sandbox.

## Control socket protocol

Listen at `<data-dir>/control.sock` using one request per connection:

1. Connect.
2. Send exactly one LF-terminated JSON object, then write-half-close the connection.
3. Receive exactly one LF-terminated JSON object.
4. Server closes the connection.

Request shape:

```json
{
  "version": 1,
  "id": "client-correlation-id",
  "command": "inbox.list",
  "params": {}
}
```

Responses echo `id` and contain exactly one of `result` or `error`. Errors contain stable machine codes and human messages. Unsupported versions fail; do not negotiate.

Fixed, tested protocol safeguards:

- Maximum request and response frame sizes
- Strict LF framing and UTF-8/JSON/schema validation
- Rejection of second/trailing frames
- Defined EOF-before-LF behavior
- Partial-frame and idle timeouts
- Default command deadlines and explicit longer Slack-network deadlines
- No file bytes in the protocol; file commands pass validated paths/IDs

### Socket security and lifecycle

- Rely on private parent-directory and socket ownership/modes for local access control; do not claim peer-UID or root exclusion.
- Create the private parent directory before binding.
- Refuse a non-socket path, foreign-owned socket, symlink, or unsafe parent.
- Probe before removing an owned stale socket.
- Remove the socket during graceful shutdown.
- Runtime CLI commands fail immediately and clearly when unavailable; they are never persisted as control requests.

Use an OS-held exclusive lock on `<data-dir>/gateway.lock` as the actual daemon/setup concurrency guarantee. The daemon holds it before opening SQLite or binding the socket. Setup/reset must acquire the same lock. Socket absence alone never proves the daemon is stopped.

## Hard-cut setup and crash-safe reset

### Setup flow

1. Resolve canonical paths and validate private ownership/modes.
2. Acquire the exclusive gateway lock.
3. Check pi installation/authentication.
4. Collect and validate both Slack tokens.
5. Run `auth.test`.
6. Require a raw `C...` or `G...` channel ID.
7. Call `conversations.info`, reject DMs/MPIMs by metadata, verify access and bot membership, and fetch the label.
8. Collect the initial trusted `U...`/`W...` user and typed operational defaults.
9. Validate every input and perform every non-destructive network check before reset work.
10. Stage and validate fresh config/database/layout.
11. Install them through the journaled reset algorithm below.
12. In interactive setup, install/start the user service. In non-interactive setup, print the explicit daemon install/start steps.

On daemon startup, refresh the channel label best-effort. A confirmed membership loss is fatal with `/invite @pi` remediation; a cosmetic label lookup failure alone is not fatal.

### Backup bundle

Every legacy replacement or current-schema reset requires confirmation and creates one non-overwritten bundle:

```text
<data-dir>/backups/reset-<UTC-timestamp>-<collision-counter>/
  manifest.json
  gateway.db
  config.env
  session/
```

- Create the bundle first under a private staging name.
- Generate `gateway.db` through SQLite's backup API after an explicit checkpoint attempt, while holding the gateway lock. This captures committed WAL data into one database image; do not copy only the main DB file.
- Validate the backup with `quick_check`, expected schema metadata where readable, and a reopen test.
- Copy the bootstrap config and active session with restrictive permissions.
- Record source paths, schema version, hashes/size metadata, and bundle phase in `manifest.json`.
- Fsync files and containing directories at durability boundaries.
- Atomically rename the validated staged bundle to its collision-free final name.
- Never overwrite an existing bundle.
- Treat the bundled session as the archived pre-reset session.
- Exempt reset bundles and legacy backups from ordinary archive/media cleanup.

Do not proceed destructively if checkpoint, backup, copy, validation, or durability steps fail. Explicitly handle and test `gateway.db-wal` and `gateway.db-shm`; never leave old sidecars beside a newly installed database.

### Staging and installation

Before changing active state:

- Create fresh config and database candidates in private temporary paths adjacent to their final targets.
- Create the fresh session/layout candidate.
- Reopen and validate the new database, singleton row, trust list, schema version, and `quick_check`.
- Parse the generated bootstrap config and validate exact values and mode `0600`.
- Validate all resulting paths and permissions.

Then write and fsync a reset journal containing the backup bundle, staged paths, active paths, rollback paths, and current phase.

Install through portable atomic renames. Generate collision-free rollback/bundle names, verify destinations are absent, hold the gateway lock, and operate only in daemon-owned private directories. Ordinary POSIX rename is acceptable under those conditions; do not require Linux-only `RENAME_NOREPLACE` or native bindings:

1. Move active config, database, WAL/SHM sidecars, and session to unique rollback paths.
2. Rename staged fresh paths into place.
3. Fsync each containing directory.
4. Reopen and validate the installed database/config/layout.
5. Mark the journal complete and fsync it.
6. Remove temporary rollback state only after installed-state validation.
7. Remove the completed journal last.

A process error attempts rollback from the untouched rollback paths or validated backup bundle. Never print setup success, install/start a daemon, or update completion messaging after a partial failure.

### Interrupted reset recovery

Daemon startup refuses to run when an incomplete reset journal exists and instructs the operator to run plain `pi-tag-slack setup`. Setup automatically enters deterministic recovery mode whenever it detects an incomplete journal. Interactive recovery clearly announces the operation and requires confirmation; non-interactive recovery requires `--yes`.

Recovery acquires the gateway lock, validates the bundle/journal, removes partial fresh state, restores config/database/session through staged atomic replacement, removes stale WAL/SHM sidecars, revalidates permissions and SQLite, and clears the journal only after durable success. It does not guess or silently roll forward.

Add failure injection after every destructive rename/write/fsync and a test whose latest committed row exists only in WAL when reset starts.

## Slack ingestion and manifest

Subscribe to `message.channels` and `message.groups`, not `app_mention`, so edits and deletions can be tracked without duplicate event streams. Before user lookup, attachment work, persistence, reaction, or response:

1. Reject bot-authored and unsupported events.
2. Reject DMs and MPIMs, using conversation metadata rather than the ambiguous `G...` prefix alone.
3. Reject a channel mismatch.
4. Attribute the event to a trusted sender. If a deletion has no attributable trusted user, acknowledge and ignore it even if an open inbox item remains.
5. Validate the top-level `event_id`.
6. For a new message, require a real raw `<@BOT_ID>` mention. For an edit/deletion, require an existing open inbox item but no repeated mention.

A new thread reply is a new message and must mention pi again. Strip the bot mention from agent-visible new-message content. A mentioned attachment-only event remains valid. Store file metadata but do not download it. An open-item edit replaces current text/attachment metadata, increments revision, and triggers a notification. An open-item deletion redacts source text/attachments, resolves as `source-deleted`, and triggers one best-effort deletion notification. Deletion notifications are not durably replayed after a crash; stale `inbox respond` is instead prevented by structured `source_deleted_at`. Mutations of resolved or unknown items are safely ignored.

Acknowledge ignored events immediately after local validation. Acknowledge relevant trusted events only after SQLite reports a committed insert/update/no-op or duplicate. Keep the pre-ack path free of Slack network calls; enrichment, reactions, and RPC notification happen afterward. Use the trusted-user record's cosmetic label or initially store the sender ID rather than delaying durability for lookup.

Verify new-message, edit, deletion, attribution, file, and thread payloads through Socket Mode public/private smoke tests. Live Slack CLI reads may fetch missing context.

Remove multi-channel registration/discovery, DMs, slash commands, Block Kit controls, trigger names, channel policy, excluded-channel policy, and App Home controls.

Update `manifest.yaml` to remove `/pi`, interactivity, `app_mention`, DM/MPIM events/scopes, and writable App Home. Retain only `message.channels`/`message.groups` subscriptions and scopes required for configured public/private conversation lookup/history, users, replies, files, and reactions. Document manifest reapplication and app reinstall/approval.

## Public CLI organization

Route through the socket:

- `inbox ...`
- `slack ...`
- `task ...`
- `schedule ...`
- `session ...`
- `config ...`
- `trust ...`

Keep local/offline:

- `setup [--reset] [--yes]`
- `daemon install|uninstall|start|stop|status|logs`
- `doctor`

When the daemon is available, `doctor` obtains database/session health through the control socket. Otherwise it may acquire the gateway lock and inspect SQLite read-only. It never opens SQLite while the lock is held by another process, performs no repair, and reports lock failure rather than bypassing it.

- `help`

The service continues to execute the public `start` entrypoint. Foreground start is not the normal documented workflow.

Plain `setup` creates state only when no application state exists, except that an incomplete reset journal makes it enter recovery mode. `setup --reset` is the sole destructive/structural reconfiguration path. Interactive reset displays backup/replacement paths and requires typing `RESET`; non-interactive reset requires `--reset --yes`. No environment condition or missing stdin implies consent.

Public IDs are prefixed SQLite integer IDs (`inbox-42`, `task-17`, `schedule-3`) and are never authorization secrets or Slack delivery identities. Gateway timestamps use UTC ISO 8601 strings with millisecond precision; Slack `ts`/`thread_ts` remain original decimal strings. Successful `--json` commands emit their direct payload with exactly one JSON value on stdout. Failures emit `{ "error": { "code": "...", "message": "..." } }` and exit nonzero; logs go to stderr. List payloads are objects with `items` and nullable `nextCursor`. Every unbounded list uses opaque cursor pagination with default limit 50 and hard maximum 200 plus a response-byte bound. Inbox/task lists default to open items and sort newest-first with ID tie-breaking.

## Tests

### Inbox and Slack idempotency

- Stable top-level `event_id` extraction from full Bolt event bodies.
- Unique event identity plus unique Slack message identity.
- Atomic event-ledger and inbox create/update/delete transactions.
- Concurrent duplicate delivery and distinct new-message events for one Slack message.
- Redelivery before and after daemon restart.
- Mentioned text, file-share, and thread-reply duplicates.
- Open-message edits replace content/attachments, increment revision, and notify once without requiring another mention.
- Trusted open-message deletion redacts/resolves and notifies once.
- Resolved/unknown mutations and unattributable/untrusted events are acknowledged, ignored, not persisted, and never crash.
- Invalid/missing event ID rejection without fallback.
- No enrichment, reactions, inbox mutation, or RPC notification on duplicate.
- Indefinite accepted-event and terminal-row deduplication.

### Agent notification and recovery

- Idle prompt versus active one-at-a-time follow-up.
- Full new-event prompt formatting and delimiting.
- Task prompt formatting.
- Final assistant output is never auto-posted.
- No automatic re-wake after a clean unresolved turn.
- New events/tasks still trigger later inspection.
- Daemon startup/session reset sends one recovery summary, not original prompt replay.
- Automatic RPC child restart sends no recovery prompt.
- Startup scheduler catch-up is included in the one recovery summary without separate notifications.
- New work after exhausted restart attempts triggers one fresh start and presents only the new work.
- Recovery summary totals and most recent three items of each kind.
- Crash between RPC acceptance and daemon bookkeeping.
- Direct task notifications record acceptance metadata; aggregate recovery does not mark individual tasks accepted.
- Deletion notification is best-effort and is not replayed; stale response is prevented by `SOURCE_DELETED`.
- Pi crash/restart backoff and degraded health.
- Trust is checked only at event ingestion; later revocation changes only future admission.
- The final trusted user may be removed; an empty trust list is valid and existing work is unchanged.

### Inbox, task, and schedule lifecycle

- Only `open -> resolved`; no reopening.
- Additional `inbox respond` to a resolved inbox item, and `SOURCE_DELETED` rejection when `source_deleted_at` is set.
- Multi-ID resolution validation.
- Arbitrary diagnostic resolution reasons never drive behavior.
- Resolved source snapshots ignore upstream Slack mutations while gateway reply metadata may advance.
- Schedule occurrence uniqueness and exact occurrence-key formats.
- One-time task creation atomically disables and retains its schedule; past re-enable fails.
- Required IANA timezone/offset validation and DST behavior.
- Disabled intervals do not catch up; recurring re-enable advances to a future occurrence; past one-time re-enable fails.
- Coalesced downtime catch-up task with first/last/count.
- Unresolved tasks are not repeatedly notified.

### Slack CLI and reactions

- Every Slack command is constrained to the configured conversation.
- Live history/message/thread pagination and size bounds.
- `slack send --thread` behavior and absence of a separate thread-reply command.
- On-demand file download ownership, size, path, deletion, and authorization cases.
- Outbound regular-file/symlink/device checks, re-stat behavior, per-file/aggregate limits, and outcome-unknown timeout behavior.
- `👀 -> ⏳`, `inbox respond` cleanup, silent-resolution `✅`, and crash/reset reversion.
- Never remove user reactions.
- Slack failure leaves inbox open.
- Slack-success/SQLite-failure partial-success reporting.
- Human and `--json` output contracts.

### Persistent RPC and session controls

- Strict RPC JSONL parsing and correlation.
- Follow-up ordering.
- RPC process shutdown/escalation and restart.
- Minimum pi version and startup capability handshake.
- RPC uses compile-time dev-dependency types but runtime-validates every frame and has no runtime Pi package dependency.
- Dedicated `follow_up`, one-at-a-time configuration, and coordinator serialization.
- Nested model/thinking command parsing, `max`, desired/effective status, and application at safe boundaries.
- Reset while idle.
- Active reset challenge using `<session-id>:<run-sequence>`.
- Stale/wrong confirmation rejection.
- Socket response flush before active process termination.
- Reset preserves open inbox/tasks and operational settings.

### Socket and local security

- One request/response per connection.
- Partial, oversized, malformed, invalid-version, second-frame, and timeout cases.
- Stable error codes and request correlation.
- Filesystem authorization through private directory/socket ownership and modes; no peer-credential or root-exclusion claim.
- Directory/socket ownership and modes.
- Unsafe/non-private custom roots.
- Non-socket, foreign-owned, symlink, and stale-socket races.
- Gateway lock exclusion between setup and daemon.

### Singleton, paths, and configuration

- Schema version is exactly 2 and every application table is SQLite `STRICT`.
- Required WAL/FULL/foreign-key/busy-timeout/trusted-schema PRAGMAs are applied and verified.
- Second singleton insert rejection.
- Missing-row and malformed-row startup failures.
- Malformed JSON/timestamps fail database checks where possible and complete application validation.
- `NULL` optional values and strict checks.
- Complete-row validation before update.
- Defaults and overrides across RPC/session restart.
- Canonical path derivation and conflicting legacy override removal.
- Resolved-path diagnostics and permissions.

### Reset and backup

- Legacy and current-schema confirmation paths.
- Consistent SQLite backup with uncheckpointed WAL data.
- Existing WAL/SHM handling.
- Bundle naming collisions never overwrite.
- Bundle manifest/config/session/database validation.
- Reset backup cleanup exemption.
- Fresh staging validation before destructive work.
- Failure injection at every destructive step.
- Startup refusal on incomplete journal.
- Plain `setup` detects the incomplete journal and performs confirmed restoration durably; non-interactive recovery requires `--yes`.
- No partial success output, daemon install, or stale token/config pointer.

### Product surface

- Single channel, real mention on new messages, event-time trusted sender, and DM/MPIM rejection.
- Setup channel membership/type and label validation.
- `message.channels`/`message.groups` new/edit/delete smoke tests and absence of `app_mention`, slash, interactivity, and DM features.
- Stable prefixed IDs, ISO/Slack timestamp formats, direct success JSON, error envelopes, opaque pagination, defaults, sorting, and bounds.
- Removal of channels, policies, slash handlers, panels, queue routing, and multi-channel concurrency tests.
- Documentation and prompt examples use only the new CLI.

## Implementation sequence

The status markers here are a summary; the detailed handoff checklist above and the normative requirements remain authoritative.

1. `[~]` Introduce canonical path resolution, ownership checks, and gateway locking. Path derivation exists; finish the safety corrections and OS-held lock before proceeding.
2. `[~]` Write and review the complete schema-v2 SQL, repository transition rules, public ID/timestamp formats, JSON fixtures, and stable error-code list before service implementation. Initial SQL/public IDs exist; definitions, fixtures, validation, transitions, and error catalog are incomplete.
3. `[~]` Implement strict schema initialization/validation, the event ledger, singleton, inbox/task/schedule/trust repositories, required PRAGMAs, and hard schema rejection. Only the singleton, basic event/inbox mutation, manual tasks, and basic trust storage exist.
4. `[~]` Build strict control-socket framing, filesystem authorization, errors, pagination, and client plumbing. Server framing and inbox/task pagination exist; complete authorization, errors, bounds, and client validation do not.
5. `[ ]` Replace one-shot pi execution with the version-checked persistent RPC lifecycle/coordinator.
6. `[ ]` Implement event-idempotent new/edit/delete Slack ingestion and prompt/follow-up notification.
7. `[~]` Implement inbox/task/schedule/trust and live Slack CLI services. Only the minimal local repository-backed subset listed above exists.
8. `[~]` Implement reaction reconciliation and on-demand attachment download/upload validation. Download validation is implemented; upload remains.
9. `[~]` Implement desired/effective session model/thinking controls and confirmed reset. Model/thinking controls are complete; confirmed reset remains.
10. `[ ]` Rebuild setup around staged backup bundles, reset journaling, plain-setup recovery, and explicit reset confirmation.
11. `[~]` Remove multi-channel, DM, slash command, panel, legacy queue, Pi runtime imports/peers, and obsolete config code. Legacy source was removed and Pi packages are development-only; dependency/config cleanup remains.
12. `[~]` Update manifest, documentation, changelog, diagnostics, and daemon definitions. The manifest and this plan are updated; the rest remains.
13. `[ ]` Add failure-injection, restart, Socket Mode mutation, systemd, and launchd validation.

Keep each checkpoint buildable and tested. Do not advance a marker to `[x]` until the associated normative behavior and tests are complete.

## Validation and rollout

Run:

1. Formatting
2. Lint
3. Unit/integration tests
4. TypeScript build
5. Frozen-lockfile install and production audit
6. Manual Linux systemd smoke test
7. Manual macOS launchd smoke test where available
8. Socket Mode public/private configured-conversation smoke test
9. Mentioned text, attachment metadata/download, and thread tests
10. Active follow-up, pi crash, and recovery-summary tests
11. Session reset confirmation tests
12. WAL reset and interrupted-reset recovery through plain `setup` tests

Release as explicitly breaking under the pre-1.0 policy. The changelog must tell operators to stop the old daemon, preserve existing data, run setup, apply the new Slack manifest, and reinstall/start the service. Never delete legacy sessions or reset backup bundles.

## Definition of done

The refactor is complete when one canonical daemon owns one configured Slack conversation and one persistent pi RPC session; Slack retries cannot duplicate inbox creation, mutation, or notification effects; pi can navigate live Slack and manage durable inbox/tasks through the CLI; restart recovery delegates semantic decisions without blindly replaying prompts; operational state has one storage root and one typed configuration authority; session reset is explicit and stale-safe; the control socket has a complete framing/authorization contract; setup/reset is WAL-safe, journaled, recoverable, and failure-injection tested; and all obsolete multi-channel and Slack UI behavior is removed.
