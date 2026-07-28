<h1 align="center">pi-tag-slack</h1>

<p align="center">A daemon-backed Slack gateway for one configured conversation and one persistent pi RPC session.</p>

`pi-tag-slack` accepts trusted, explicitly mentioned Slack work into a durable inbox and presents it to one daemon-owned [pi](https://github.com/badlogic/pi-mono) session. Pi decides whether and how to act; ordinary assistant output remains in that pi session and is never posted to Slack automatically.

> [!WARNING]
> This is a breaking alpha release. The configured working directory and its project resources are trusted by pi. Trusted Slack users can influence the agent's decisions and tool use with the daemon account's local filesystem, process, network, and credential capabilities; Slack trust is therefore remote authority over that account, not merely permission to chat. Anyone with the same OS UID can use the local CLI/control socket with equivalent authority; this is not a privilege boundary. Do not run it as root. Pi runs in headless RPC mode: user or project extensions that open interactive UI, dialogs, or prompts may wait forever and block the persistent session. Disable those extensions for the daemon because interactive extension support is out of scope.

## Requirements

- Node.js 22.19 or newer on Linux or macOS
- pi 0.82.0 or newer, installed and authenticated for the daemon account
- A Slack app using Socket Mode and a bot already invited to one public or private conversation

The configured conversation is exactly one raw `C...` (public) or `G...` (private) ID. DMs and multi-person direct messages are unsupported.

## Install and setup

```bash
pnpm add -g @stayradiated/pi-tag-slack
```

1. Create a Slack app from [`manifest.yaml`](./manifest.yaml), enable Socket Mode, install it to the workspace, and create an app-level token with `connections:write`.
2. Invite the bot to the one conversation it will serve. Copy its `C...` or `G...` ID and the initial trusted member ID (`U...` or `W...`).
3. Export the two bootstrap tokens and run setup. Setup validates pi, Slack authentication, conversation type/access/membership, and the trusted user before writing state.

```bash
export SLACK_BOT_TOKEN='xoxb-…'
export SLACK_APP_TOKEN='xapp-…'
pi-tag-slack setup \
  --channel C0123456789 \
  --cwd /absolute/path/to/trusted-project \
  --model provider/model \
  --trusted-user U0123456789
```

`--pi-bin <path>` and `--thinking <off|minimal|low|medium|high|xhigh|max>` are optional setup inputs. Interactive `pi-tag-slack setup` collects missing values and installs/starts the user service on success. Non-interactive setup prints the next steps:

```bash
pi-tag-slack daemon install
pi-tag-slack daemon start
```

Reapply the manifest and approve/reinstall the Slack app whenever its scopes or event subscriptions change. The shipped manifest subscribes only to `message.channels` and `message.groups`; it requests the conversation, history, user, file, reaction, and send scopes needed by this gateway.

## Slack admission and communication

Only the configured conversation is considered. A new inbound message, including a new thread reply, must contain a real raw bot mention such as `<@BOT_ID>`. The bot mention is removed from the agent-visible new-message text. Edits and deletions apply only to an existing open inbox item and do not need a repeated mention.

Trust is checked at event admission time only. The sender must be in the trusted-user list; untrusted events are acknowledged and ignored without persistence or Slack side effects. An empty list is valid and stops future admission without changing already accepted inbox items or tasks.

Pi communicates to Slack only by explicitly running one of these commands:

- `pi-tag-slack slack send ...`
- `pi-tag-slack inbox respond ...`

Use `inbox respond` to reply to an inbox source and resolve an open item on confirmed success. Use `slack send`, optionally with `--thread`, for communication that does not change inbox or task lifecycle. Inspect Slack and inbox state before retrying an `OUTCOME_UNKNOWN` send/respond result.

## Data and bootstrap configuration

One canonical data directory contains all operational state:

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

The bootstrap config contains only `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. Its location and the data directory may be overridden only with:

```bash
PI_TAG_SLACK_CONFIG=/private/path/config.env
PI_TAG_SLACK_DATA_DIR=/private/path/data
```

All other operational settings, including the working directory, pi binary, model, thinking level, retention, limits, scheduler batch limit, and log level, are persisted in SQLite and managed through `config`/`session` commands. Keep the data directory and bootstrap config private to the daemon UID.

## Daemon lifecycle

The daemon owns the SQLite database, Slack client, control socket, and one persistent pi RPC process. Runtime commands require that daemon; they do not open SQLite or create another Slack client.

```bash
pi-tag-slack daemon install
pi-tag-slack daemon start
pi-tag-slack daemon status
pi-tag-slack daemon logs
pi-tag-slack daemon stop
pi-tag-slack daemon uninstall

pi-tag-slack doctor
```

`start` runs the gateway in the foreground and is primarily the service entrypoint. `doctor` uses daemon health when available, otherwise performs lock-gated read-only diagnostics.

### Alpha log retention decision

Automatic log rotation and deletion are explicitly deferred for alpha. On Linux, logs go to the systemd journal and retention is whatever the host's `journald` policy provides. On macOS, launchd appends to `<data-dir>/daemon.stdout.log` and `<data-dir>/daemon.stderr.log`; the gateway does not rotate or truncate them. Operators must configure host rotation/retention and monitor disk use. `archiveRetentionDays` and `mediaRetentionHours` do not apply to daemon logs.

## CLI reference

Successful read/list commands support `--json`; list commands use `--limit` and `--cursor` where shown. Runtime failures have stable error codes.

### Inbox and Slack

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
```

Slack navigation always reads the configured conversation live and does not ingest ambient history. File download is on demand. Outbound files must be daemon-readable regular files; symlinks, directories, devices, and sockets are rejected, and configured file/aggregate limits apply. Uploads are identity-checked again immediately before the Slack API call, but the Web API library later reopens the path. A process with the same UID can still replace or modify a file in that interval (including an in-place change that preserves checked metadata), so upload validation is best-effort TOCTOU hardening, not protection from same-UID processes. Copy sensitive output into a private, stable file before sending.

### Tasks and schedules

```text
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
```

Tasks and inbox items move only from open to resolved. Schedules create durable tasks; a one-time schedule requires an explicit UTC offset, and recurring schedules require an IANA timezone.

### Trust, configuration, and session

```text
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

`trust add` validates the Slack user before saving it. `config set` accepts only the supported persisted non-structural keys: `defaultModel`, `defaultThinking`, `sessionModelOverride`, `sessionThinkingOverride`, `archiveRetentionDays`, `mediaRetentionHours`, `maxAttachmentBytes`, `maxTotalAttachmentBytes`, `schedulerBatchLimit`, and `logLevel`.

A session reset preserves configured state and open work, archives the prior session, starts a fresh persistent session, and sends a neutral recovery summary. If pi is active, first run `session reset`; then run the exact confirmation command it returns. Do not guess or reuse a stale confirmation value.

## Breaking migration and reinstall

This release does not migrate prior state. Preserve it.

1. Stop the old daemon/service.
2. Preserve the old data directory, bootstrap config, and all old session directories. Do **not** delete legacy sessions or any reset backup bundle.
3. Install the new package. Pi is invoked only through the configured `pi` executable; this package does not bundle or import Pi as a runtime library.
4. Run the new `pi-tag-slack setup` for the one intended conversation and trusted user. Use `setup --reset --yes` only when deliberately replacing existing gateway state; reset creates a backup bundle.
5. Reapply [`manifest.yaml`](./manifest.yaml) in Slack, then reinstall/approve the app so the new scopes and event subscriptions take effect.
6. Reinstall and start the user service:

```bash
pi-tag-slack daemon uninstall
pi-tag-slack daemon install
pi-tag-slack daemon start
pi-tag-slack daemon status
```

Keep preserved pre-release data available for rollback and forensic inspection. No legacy data is silently adopted by the new daemon.

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
