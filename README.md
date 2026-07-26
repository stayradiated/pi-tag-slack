<h1 align="center">pi-tag-slack</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@stayradiated/pi-tag-slack"><img src="https://img.shields.io/npm/v/@stayradiated/pi-tag-slack?cacheSeconds=3600" alt="npm version"></a>
  <img src="https://img.shields.io/npm/l/@stayradiated/pi-tag-slack?cacheSeconds=3600" alt="license">
  <img src="https://img.shields.io/node/v/@stayradiated/pi-tag-slack?cacheSeconds=3600" alt="node version">
  <img src="https://img.shields.io/badge/platform-linux%20%7C%20macos-blue" alt="platform">
</p>

Bring the [pi coding agent](https://github.com/badlogic/pi-mono) into Slack. Start work from your desktop or phone, keep a persistent session for each channel, share files in both directions, and schedule recurring tasks.

- Chat with pi in DMs, channels, and threads
- Give each channel its own working directory, model, and thinking level
- Send files to pi by dropping them into Slack; receive generated files in return
- Run one-time and recurring tasks on a schedule
- Control sessions from an interactive `/pi` panel
- Connect through Slack Socket Mode—no public URL or inbound port required

> [!WARNING]
> **Access to this bot is equivalent to shell access to the gateway account.** Pi can read and modify files, run commands, and use that account's credentials. Only trust people who should have that level of access, and never run the gateway as root. See [Access and security](#access-and-security).

## Contents

- [Requirements](#requirements)
- [Install and set up](#install-and-set-up)
- [Using pi in Slack](#using-pi-in-slack)
- [Access and security](#access-and-security)
- [Sessions](#sessions)
- [File transfer](#file-transfer)
- [Scheduled tasks](#scheduled-tasks)
- [Running as a daemon](#running-as-a-daemon)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- **Node.js** ≥ 22.19
- **[pi](https://github.com/badlogic/pi-mono)** ≥ 0.80 on `PATH`, with login completed (`~/.pi/agent/auth.json`)
- **A Slack workspace** where you can create apps (the free plan is fine)
- Linux or macOS; Windows is unsupported

pi-tag-slack runs on the same machine as pi and drives your existing installation, including its authentication and model access.

## Install and set up

### 1. Install the gateway

```bash
pnpm add -g @stayradiated/pi-tag-slack
```

To run setup without a global installation:

```bash
pnpm dlx @stayradiated/pi-tag-slack@latest setup
```

### 2. Create the Slack app

1. Open [api.slack.com/apps](https://api.slack.com/apps).
2. Select **Create New App** → **From a manifest**.
3. Pick your workspace and paste [`manifest.yaml`](./manifest.yaml).
4. Select **OAuth & Permissions** → **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
5. Under **Basic Information** → **App-Level Tokens**, create a token with the `connections:write` scope and copy it (`xapp-…`).

The manifest enables Socket Mode, required events and scopes, interactivity, and the `/pi` command. Token rotation remains disabled because the gateway stores static `xoxb-` and `xapp-` tokens; revoke and reissue them if they are compromised.

### 3. Run the setup wizard

```bash
pi-tag-slack setup
```

The wizard checks prerequisites, collects both Slack tokens and your raw Slack member ID (`U...` or `W...`), configures access policies and the default working directory, and can install a background service.

Find your member ID in Slack from **Profile** → **⋮** → **Copy member ID**.

### 4. Verify the installation

```bash
pi-tag-slack status
pi-tag-slack daemon status   # if you installed the background service
```

Open a DM with the bot and send a message. For a channel, first invite and register the bot:

```text
/invite @pi
```

```bash
pi-tag-slack register C0123456789 "team #general" --cwd /path/to/project
```

Channel IDs appear at the bottom of the channel's **About** tab. IDs start with `C` for public channels, `G` for private channels, and `D` for DMs.

## Using pi in Slack

### Messages and threads

- **DMs:** Every message reaches pi by default (`DM_POLICY=open`).
- **Channels:** In trigger-gated channels, summon pi by @mentioning it or by starting the message with `TRIGGER_NAME`, such as `@pi fix the build` or `pi-tag-slack fix the build`.
- **Threads:** Responses are posted in the triggering message's thread. Threads are reply locations; the whole channel shares one session.
- **Progress:** An hourglass reaction appears while pi is working. Long responses are formatted for Slack and split at Slack's 4,000-character limit.

Mentioning the bot in an unregistered channel returns a short registration hint, rate-limited to once every 10 minutes per channel.

### The `/pi` panel

Run `/pi` with no arguments to open an ephemeral control panel visible only to you. It shows session status and provides model and thinking-level selectors plus **New session** and **Stop** buttons.

Text commands are also available:

| Command                | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `/pi`                  | Open the interactive panel                                         |
| `/pi help`             | Show text usage                                                    |
| `/pi status`           | Show model, thinking, working directory, session info, token usage |
| `/pi model <ref>`      | Set the channel model using a fuzzy catalog match                  |
| `/pi models`           | List models currently available to pi                              |
| `/pi reset-model`      | Clear the channel model override                                   |
| `/pi thinking <level>` | Set `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`          |
| `/pi new`              | Start a fresh session for this channel                             |
| `/pi stop`             | Abort the current task and clear queued messages                   |

The model list comes from your installed pi and honors its `enabledModels` setting.

## Access and security

A user must pass both layers of access control:

1. Their raw Slack member ID must be trusted.
2. The DM or channel must be permitted by the applicable policy.

Manage trusted users from the gateway machine:

```bash
pi-tag-slack trust add U0123456789
pi-tag-slack trust remove U0123456789
pi-tag-slack trust list
```

A trusted user must be treated as having shell access to the gateway account. Pi can also invoke `pi-tag-slack trust`, so indirect prompt injection can alter the trust list; the list is not a security boundary against an already trusted user. Use a dedicated OS account if you need stronger isolation.

### Channel policy

Set with `CHANNEL_POLICY`:

| Policy         | Behavior                                                    |
| -------------- | ----------------------------------------------------------- |
| `allowlist`    | Only manually registered channels are active. **Default.**  |
| `open`         | Channels auto-register and all messages trigger pi.         |
| `open-trigger` | Channels auto-register, but pi responds only when summoned. |

Slack delivers channel messages only after the bot has been invited, so even an open policy is gated by `/invite @pi`. Group DMs behave like channels and follow `CHANNEL_POLICY`. Use `EXCLUDED_CHANNELS` to block specific IDs from automatic registration.

### DM policy

Set independently with `DM_POLICY`:

| Policy      | Behavior                                                     |
| ----------- | ------------------------------------------------------------ |
| `open`      | DMs auto-register on first message. **Default.**             |
| `allowlist` | Only DMs registered with `pi-tag-slack register` are active. |
| `disabled`  | All DMs are ignored.                                         |

### Security guidance

- **Assume prompt injection.** Messages, pasted text, and attachments can contain instructions that pi may follow. Prefer trigger-gated channels and avoid busy public channels.
- **Run one instance as a normal user.** Never run the gateway as root or connect two instances to the same Slack app.
- **Protect `config.env`.** It contains both long-lived Slack tokens and is created with mode `0600`.
- **Use a dedicated account for isolation.** This limits which files and credentials the agent can access.

The bundled manifest requests the scopes needed for message events, replies, files, reactions, user lookup, channel labels, and slash commands. The gateway does not fetch channel history; it processes events pushed by Slack.

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Sessions

- Each registered channel or DM has its own persistent pi session and message queue.
- Each channel can override the default working directory, model, and thinking level.
- `/pi new` archives the current session and starts a fresh one.
- Archived sessions are removed after `ARCHIVE_RETENTION_DAYS`; set it to `0` to disable cleanup.
- Messages within a channel run serially. Global parallelism is limited by `MAX_CONCURRENCY`.

Register a channel with a project-specific working directory:

```bash
pi-tag-slack register C0123456789 "team #general" --cwd /srv/repos/app
```

## File transfer

### Send files to pi

Drop a file into a Slack message. The gateway downloads it and gives pi its local path, allowing the agent to inspect or modify the file without embedding the entire file in its context.

### Receive files from pi

Ask pi to send the result. Pi can invoke:

```bash
pi-tag-slack send --channel C0123456789 --thread 1234567890.123456 --file /absolute/path/to/file
```

Up to 10 files may be sent per message, subject to the configured attachment size limits.

## Scheduled tasks

Ask pi in plain language:

> Create a daily task at 9am UTC that generates a summary report.

> Set a one-time reminder for today's 2pm meeting.

Pi uses `pi-tag-slack task add` behind the scenes. Recurring tasks accept a five-field cron expression; one-time tasks use an ISO 8601 datetime with `--once`. Cron schedules use the gateway machine's local timezone, so include the intended timezone in your request. For one-time tasks, prefer an ISO datetime with an explicit UTC offset.

Scheduled prompts enter the normal message queue and use the channel's model, thinking level, and working directory.

```bash
pi-tag-slack task list
pi-tag-slack task enable <id>
pi-tag-slack task disable <id>
pi-tag-slack task remove <id>
```

## How it works

```text
Slack ── Socket Mode (@slack/bolt) ──> Gateway ── pi subprocess ──> Pi Agent
                                           │                            │
                                         SQLite                    Session dirs
                                      (message queue)             (per channel)
```

The gateway shells out to your `pi` binary (`PI_BIN` or `PATH`) rather than embedding or replacing it. Each message runs with a channel-specific session directory and continues the previous conversation.

Slack events are acknowledged immediately and written to SQLite before processing. Accepted messages therefore survive gateway crashes and restarts.

Run **exactly one gateway instance per Slack app**. Socket Mode load-balances events across connections, so a second instance can silently receive half the messages and split session state.

## Running as a daemon

The setup wizard can install a background service. You can also manage it manually:

```bash
pi-tag-slack daemon install
pi-tag-slack daemon start
pi-tag-slack daemon status
pi-tag-slack daemon logs
pi-tag-slack daemon stop
pi-tag-slack daemon uninstall
```

- **Linux:** systemd user service named `pi-tag-slack`. On a headless server, enable lingering with `sudo loginctl enable-linger $USER`.
- **macOS:** launchd user agent named `com.stayradiated.pi-tag-slack`.

## Configuration

`pi-tag-slack setup` creates the configuration file. Use `pi-tag-slack status` to see its exact path:

- Linux: `~/.config/pi-tag-slack/config.env`
- macOS: `~/Library/Application Support/pi-tag-slack/config.env`

Set `PI_TAG_SLACK_CONFIG` to override the location. After editing the file, restart the daemon:

```bash
pi-tag-slack daemon stop && pi-tag-slack daemon start
```

| Variable                     | Default                        | Description                                                        |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `SLACK_BOT_TOKEN`            | required                       | Bot User OAuth Token (`xoxb-…`)                                    |
| `SLACK_APP_TOKEN`            | required                       | App-level Socket Mode token (`xapp-…`) with `connections:write`    |
| `PI_BIN`                     | `pi`                           | Path to the pi binary                                              |
| `PI_MODEL`                   | none                           | Default model override                                             |
| `PI_THINKING`                | none                           | Default thinking level                                             |
| `PI_CWD`                     | `$HOME`                        | Default working directory; may be overridden per channel           |
| `PI_EXTRA_FLAGS`             | none                           | Additional flags passed to pi                                      |
| `TRIGGER_NAME`               | `pi-tag-slack`                 | Name that summons the bot at the start of a channel message        |
| `CHANNEL_POLICY`             | `allowlist`                    | `open`, `open-trigger`, or `allowlist`                             |
| `EXCLUDED_CHANNELS`          | none                           | Comma-separated IDs excluded from automatic registration           |
| `DM_POLICY`                  | `open`                         | `open`, `allowlist`, or `disabled`                                 |
| `MAX_CONCURRENCY`            | `3`                            | Maximum parallel pi invocations                                    |
| `MAX_SCHEDULED_CONCURRENCY`  | `1`                            | Maximum scheduled tasks enqueued per scheduler tick                |
| `POLL_INTERVAL_MS`           | `1000`                         | Queue polling interval in milliseconds                             |
| `SHUTDOWN_TIMEOUT_MS`        | `15000`                        | Graceful shutdown timeout in milliseconds                          |
| `ARCHIVE_RETENTION_DAYS`     | `30`                           | Days to retain archived sessions; `0` disables cleanup             |
| `MAX_ATTACHMENT_BYTES`       | `26214400`                     | Maximum bytes per attachment; `0` means unlimited                  |
| `MAX_TOTAL_ATTACHMENT_BYTES` | `52428800`                     | Maximum combined attachment bytes per message; `0` means unlimited |
| `MEDIA_RETENTION_HOURS`      | `168`                          | Hours to retain downloaded attachments                             |
| `SESSIONS_DIR`               | platform default `/sessions`   | Session storage directory                                          |
| `DB_PATH`                    | platform default `/gateway.db` | SQLite database path                                               |
| `LOG_LEVEL`                  | `info`                         | `debug`, `info`, `warn`, or `error`                                |

Application data lives in `~/.local/share/pi-tag-slack/` on Linux and `~/Library/Application Support/pi-tag-slack/` on macOS.

## CLI reference

```text
pi-tag-slack setup                                   Interactive setup wizard
pi-tag-slack start                                   Start gateway in the foreground
pi-tag-slack status                                  Show diagnostics

pi-tag-slack channels                                List registered channels
pi-tag-slack register <id> <name> [options]          Register a channel
pi-tag-slack unregister <id>                         Unregister a channel

pi-tag-slack send --channel <id> [--thread <slack-ts>] [--text <msg>] [--file <path> ...]
pi-tag-slack trust add <user-id> | remove <user-id> | list

pi-tag-slack task add --name <n> --schedule <cron|iso> --channel <id> --prompt <text> [--once]
pi-tag-slack task list | remove <id> | enable <id> | disable <id>

pi-tag-slack archive list
pi-tag-slack archive cleanup [--dry-run]

pi-tag-slack daemon install | uninstall | start | stop | status | logs
```

Channel IDs may be passed bare or with an `sl:` prefix, such as `C0123456789` or `sl:C0123456789`.

Registration options:

- `--cwd <path>` sets the channel's working directory.
- `--folder <name>` sets a custom relative session folder.
- `--no-trigger` responds to every message instead of requiring a summon.
- `--main` marks the channel as the main channel and implies `--no-trigger`.

`pi-tag-slack send` works without a running gateway. The `send`, `task`, and `trust` commands are also available to pi when a user asks it to perform those actions.

## Troubleshooting

<details>
<summary><strong>pi not found in PATH</strong></summary>

`pi-tag-slack status` reports `Pi binary: not found`.

- Confirm `pi --version` works for the same user running the gateway.
- Set `PI_BIN=/full/path/to/pi` in `config.env`.
- Restart the daemon.

</details>

<details>
<summary><strong>Missing auth.json</strong></summary>

`pi-tag-slack status` reports `Pi auth: missing`.

- Run `pi` and complete the login flow.
- Confirm `~/.pi/agent/auth.json` exists for the gateway user.

</details>

<details>
<summary><strong>The daemon will not start</strong></summary>

- Run `pi-tag-slack daemon status` to check for errors.
- Run `pi-tag-slack daemon logs` to inspect output.
- On a headless Linux server, run `sudo loginctl enable-linger $USER`.
- On macOS, inspect `daemon.stdout.log` and `daemon.stderr.log` in the data directory.

</details>

<details>
<summary><strong>The bot is online but does not respond</strong></summary>

- Confirm the sender is listed by `pi-tag-slack trust list`.
- Invite the bot to the channel with `/invite @pi`.
- With the default `allowlist` policy, confirm the channel appears in `pi-tag-slack channels`.
- With `open` or `open-trigger`, confirm `EXCLUDED_CHANNELS` does not contain the channel ID.
- In a trigger-gated channel, mention the bot or begin the message with `TRIGGER_NAME`.
- For DMs, confirm `DM_POLICY` is not `disabled`.
- Verify both tokens with `pi-tag-slack status`.

</details>

<details>
<summary><strong>Replies are intermittent or sessions lose context</strong></summary>

This usually means two gateway instances are connected to the same Slack app. Socket Mode distributes events across connections, causing each instance to receive only some messages and maintain separate session state.

Stop the daemon, check for stray `pi-tag-slack start` processes, and then start exactly one instance.

</details>

## Development

```bash
git clone https://github.com/stayradiated/pi-tag-slack.git
cd pi-tag-slack
corepack enable
pnpm install --frozen-lockfile
pnpm run dev         # run with tsx; no build required
pnpm run lint
pnpm test
pnpm run build
```

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md), and review release notes in the [Changelog](./CHANGELOG.md).

## License

MIT

## Acknowledgments

- Forked from [piscord](https://github.com/Crokily/pi-discord-gateway)—the same core engine with a Slack platform layer
- Architecture inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw)
- Built for [pi-mono](https://github.com/badlogic/pi-mono) by [@badlogic](https://github.com/badlogic)
