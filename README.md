<h1 align="center">pi-tag-slack</h1>

<p align="center">A daemon-backed Slack gateway for one configured conversation and one persistent pi RPC session.</p>

`pi-tag-slack` accepts explicitly mentioned messages from trusted Slack users into a durable inbox and presents them to one daemon-owned [pi](https://github.com/badlogic/pi-mono) session. Pi decides whether and how to act. Ordinary pi output stays in that session; nothing is posted to Slack unless pi explicitly runs this CLI.

> [!WARNING]
> **Alpha evaluator/development software — not ready to ship.** This is Linux/systemd-user-manager only. Live Slack/systemd validation, supported Node 22/24 CI, release gates, and the product delivery contract remain incomplete. In particular, a crash between pi accepting a notification and the gateway recording that acceptance can cause a retry; do not rely on exactly-once pi notification.
>
> The configured working directory is trusted by pi. A trusted Slack user can influence pi's decisions and tool use with the daemon account's filesystem, process, network, and credential capabilities. Slack trust is remote authority over that account, not merely permission to chat. Anyone using the same OS UID can use the local control socket with equivalent authority; it is not a privilege boundary. Do not run it as root. Pi runs headless RPC: extensions that open UI, dialogs, or prompts can block the persistent session indefinitely and must be disabled for the daemon.

## Release status and scope

This repository is an alpha implementation for evaluation, not a validated published-service promise. It supports exactly one configured public (`C...`) or private (`G...`) Slack conversation. DMs and multi-person DMs are unsupported. Do not treat configured CI/release workflows as evidence that their gates have run.

## Requirements and install

- Linux, Node.js 22.19 or newer, and a systemd **user** manager
- pnpm 11.15.1 (or `corepack enable` to provide the version declared by this package)
- pi 0.82.0 or newer, installed and authenticated as the daemon account
- A Slack app using Socket Mode, with its bot invited to the one target conversation

```bash
corepack enable
pnpm add -g @stayradiated/pi-tag-slack
```

## Slack app and setup

1. Create a Slack app from [`manifest.yaml`](./manifest.yaml), enable Socket Mode, install it to the workspace, and create an app-level token with `connections:write`.
2. Invite the bot to the target conversation. Record its raw `C...` or `G...` ID and an initial trusted member's `U...` or `W...` ID.
3. Provide bootstrap tokens and run setup. Interactive setup asks for the initial trusted user first. Token input is intentionally visible: this keeps literal tokens out of command-line arguments and shell history, but exposes them to screen observers and terminal recording software. For automation, obtain tokens through a secret manager or another history-safe mechanism; do not put literal tokens in commands or `export` statements.

```bash
pi-tag-slack setup \
  --channel C0123456789 \
  --cwd /absolute/path/to/trusted-project \
  --model provider/model \
  --trusted-user U0123456789
```

Setup reports each validation stage, uses bounded setup-only Pi and Slack requests, and validates pi, the Slack tokens, Socket Mode authentication, conversation type/access/membership, and the trusted user before staging and installing state. Same-user managed files and directories with incorrect modes are repaired to `0600`/`0700`; symlinks, foreign-owned paths, and wrong file types are refused. `--thinking <off|minimal|low|medium|high|xhigh|max>` is optional.

`--pi-bin` defaults to `pi`; it may be a command name found on setup's `PATH` or an absolute path, but not a relative path. Setup resolves, checks, and stores the canonical absolute executable, so the systemd service does not depend on the invoking shell's `PATH`.

Setup never installs or starts a service. After either interactive or non-interactive success, explicitly run:

```bash
pi-tag-slack daemon install
pi-tag-slack daemon start
pi-tag-slack daemon status
```

Reapply the manifest and reinstall/approve the Slack app whenever scopes or subscriptions change. The manifest subscribes only to `message.channels` and `message.groups`; it requests the conversation/history/user/file/reaction/send scopes used by this gateway.

## Slack admission and delivery

Only Events API `message` events in the configured conversation are eligible, and the channel type must be public or private channel/group. Bot-authored events, `bot_message`, unsupported subtypes, invalid/missing top-level `event_id`, and missing message timestamps are acknowledged and ignored. New messages, including `file_share` and new thread replies, require a raw `<@BOT_ID>` mention and a trusted sender. The complete original text **including that mention** is retained and shown to pi.

Trust is checked at admission. Untrusted events have no persistence or Slack side effect. An empty trust list stops future admission without changing accepted work.

Edits and deletions are separately trust-checked and apply only to an existing open inbox item; they do not need a current mention. A substantive edit retains the full current text and attachment metadata and advances the revision, even if it removes a mention. Deletion resolves the item as `source-deleted`, clears retained source content/attachments and gateway reaction state, and makes `inbox respond` fail with `SOURCE_DELETED`. Events for missing or resolved items are inert.

Slack can emit parent `message_changed` events for reply-count/latest-reply changes. If the gateway-owned snapshot (text plus attachment metadata) is unchanged, this is a synthetic no-op: it is acknowledged, intentionally not ledgered, and does not notify pi. Mentioned thread replies are distinct new inbox items.

The SQLite ledger deduplicates accepted top-level Slack event IDs; admission commits before Socket Mode acknowledgement, and pending post-commit effects replay on daemon start. This is **not end-to-end exactly once**: pi can accept a notification before local acceptance metadata is written, and a crash in that interval may notify pi again during recovery. Treat pi notifications as prompts to inspect durable inbox/task state, not unique commands.

Pi communicates to Slack only by explicitly running:

- `pi-tag-slack inbox respond ...` — replies to an inbox source and resolves it after confirmed success.
- `pi-tag-slack slack send ...` — sends a standalone or threaded message without changing inbox/task lifecycle.

For `OUTCOME_UNKNOWN` from either command, inspect the target conversation/thread before retrying. This is especially important for uploads: a transport failure or ambiguous completion can mean Slack already accepted one or more files. Inbound attachment ingestion retains metadata only (`id`, name, MIME type, size); it does not download content. `slack file download` live-checks that a file is shared in the configured conversation and stores it in private media storage.

Outbound files must be daemon-readable regular files; symlinks, directories, devices, and sockets are rejected, and configured per-file/aggregate limits apply. Identity is checked immediately before the Slack API call, but the Web API library reopens the path later. A same-UID process can replace or modify it in that interval, including with preserved metadata. This is best-effort TOCTOU hardening, not protection from same-UID processes; use a private stable copy for sensitive output.

## Data and security

Linux defaults are:

```text
Bootstrap config: ~/.config/pi-tag-slack/config.env
Data directory:  ~/.local/share/pi-tag-slack
```

The bootstrap config holds `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and optionally `EXTRA_PATH`. `EXTRA_PATH` is a colon-separated list of directories prepended to `PATH` only when pi is checked or launched; use it for a Pi shell shim whose runtime is outside systemd's default PATH. Files are private (`0600`) and structural directories are private (`0700`) for the daemon UID. Override locations only with:

```bash
PI_TAG_SLACK_CONFIG=/private/path/config.env
PI_TAG_SLACK_DATA_DIR=/private/path/data
```

The data directory contains operational state:

```text
gateway.db
gateway.lock
control.sock
sessions/session/
sessions/archive/
media/
backups/
reset-journal.json
```

The working directory and canonical pi executable are immutable bootstrap settings. Changing either after initial setup requires setup/reset rather than `config` or `session` mutation. Keep both locations private to the daemon UID.

## Systemd lifecycle and logs

`pi-tag-slack start` runs the gateway in the foreground; it is the service entrypoint and normally not the operator-facing way to start a background service. `pi-tag-slack daemon start` starts the installed systemd user service.

```bash
pi-tag-slack daemon install
pi-tag-slack daemon start
pi-tag-slack daemon status
pi-tag-slack daemon logs
pi-tag-slack daemon stop
pi-tag-slack daemon uninstall

# Foreground/service entrypoint
pi-tag-slack start

# Health diagnostics (uses daemon health when available)
pi-tag-slack doctor
```

On Linux, stdout and stderr go to the systemd journal; `daemon logs` follows `journalctl --user`. There are no canonical Linux `daemon.stdout.log`/`daemon.stderr.log` files. Log rotation/deletion is deferred for alpha: configure host `journald` retention and monitor disk use. `archiveRetentionDays` and `mediaRetentionHours` do not affect journal logs. `daemon status` also checks runtime health and exits nonzero if systemd is running but the gateway is degraded.

## Commands

Successful read/list commands accept `--json`; list commands support `--limit` and `--cursor` where shown.

```text
pi-tag-slack inbox list [--state <open|resolved|all>] [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack inbox show <inbox-id> [--json]
pi-tag-slack inbox working <inbox-id>
pi-tag-slack inbox respond <inbox-id> --text <text> [--file <path> ...]
pi-tag-slack inbox resolve <inbox-id> [<inbox-id> ...] [--reason <text>]

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
pi-tag-slack schedule add --title <text> --instructions <text> --cron <five-field-expression> --timezone <IANA-timezone>
pi-tag-slack schedule list [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack schedule show <schedule-id> [--json]
pi-tag-slack schedule enable <schedule-id>
pi-tag-slack schedule disable <schedule-id>
pi-tag-slack schedule remove <schedule-id>

pi-tag-slack trust list [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack trust add <U...|W...>
pi-tag-slack trust remove <U...|W...>

pi-tag-slack config show [--json]
pi-tag-slack config set <key> <value>
pi-tag-slack config reset <key>

pi-tag-slack session status [--json]
pi-tag-slack session reset
pi-tag-slack session reset --confirm <session-id>:<active-run-sequence>
pi-tag-slack session model list [--json]
pi-tag-slack session model set <provider/model>
pi-tag-slack session model reset
pi-tag-slack session thinking set <off|minimal|low|medium|high|xhigh|max>
pi-tag-slack session thinking reset
pi-tag-slack session archive list [--limit <n>] [--cursor <opaque>] [--json]
pi-tag-slack session archive cleanup
```

Slack navigation reads the configured conversation live; it does not ingest ambient history. Tasks and inbox items only move from open to resolved. Schedules create durable tasks; a one-time schedule needs an explicit UTC offset and a recurring schedule needs an IANA timezone. `trust add` validates the Slack user. `config set` supports only `defaultModel`, `defaultThinking`, `sessionModelOverride`, `sessionThinkingOverride`, `archiveRetentionDays`, `mediaRetentionHours`, `maxAttachmentBytes`, `maxTotalAttachmentBytes`, `schedulerBatchLimit`, and `logLevel`.

## Reset and recovery

A normal `session reset` preserves configuration and open work, archives the old persistent session, creates a new one, and sends a neutral summary of currently open inbox/tasks. If `session status` reports `lastFailure.event: "pi_prompt_preflight_timeout"`, use this reset to safely recover a resumed session that may be stalled in Pi prompt preflight/compaction; the old session remains in the archive. If pi is active, it returns an exact confirmation command. Run that exact command without guessing or reusing a stale value; `STALE_CONFIRMATION` means it is no longer valid. A successful confirmation means the reset was accepted after the response was delivered, not that archival/restart/recovery has completed. Verify with `session status`, archive listing, and logs. Recovery summaries are prompts to inspect durable work, not proof of one-time execution.

`setup` is lock-serialized: stop the daemon first. Plain setup never replaces state. To intentionally replace state, use `setup --reset --yes` non-interactively (or confirm interactively). It validates and stages the replacement before installation, and creates a backup bundle before replacing active state.

If a reset is interrupted, an incomplete `reset-journal.json` blocks normal non-interactive setup. Recover it exactly with:

```bash
pi-tag-slack setup --yes
```

Here `--yes` **without** `--reset` is reserved only for interrupted-reset recovery; it is not generic setup consent. Interactive plain setup offers recovery instead.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm test
pnpm run build
```

## License

MIT
