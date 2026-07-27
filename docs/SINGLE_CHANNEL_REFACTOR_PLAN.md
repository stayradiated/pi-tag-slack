# Single-channel and CLI-control refactor plan

## Goal

Make `pi-tag-slack` a gateway for one configured Slack conversation rather
than a multi-channel router. Remove Slack slash commands and expose the same
session controls through `pi-tag-slack` so the agent can execute them locally.
Trusted Slack users remain a separate, multi-user access list.

## Product decisions

- Setup records one required `SLACK_CHANNEL_ID` (`C...` or `G...`) and its
  display label. The gateway ignores every other Slack conversation; DMs are
  unsupported.
- A channel is no longer registered, discovered, or selected at runtime. DMs,
  allowlists, open-channel policies, excluded-channel lists, per-channel
  folders, and per-channel cwd/model/thinking overrides are removed.
- The one conversation has one persistent session, queue, working directory,
  model override, and thinking override. Existing global defaults remain the
  fallback settings.
- The gateway continues to require trusted-user IDs. A trusted user can use
  the configured conversation by explicitly `@pi`-mentioning it; untrusted
  messages and unmentioned channel traffic are ignored.
- The CLI and agent prompt target the configured conversation implicitly:
  `session status`, `session models`, `session model <ref>`,
  `session reset-model`, `session thinking <level>`, `session new`, and
  `session stop`. `send` retains `--thread` but no longer requires
  `--channel`; scheduled tasks likewise stop accepting a channel argument.
- Removing `/pi` also removes its Block Kit panel. Session controls are
  intentionally agent-operated CLI actions, not Slack UI actions.

## Implementation phases

### 1. Replace channel configuration and persistence

1. Add `SLACK_CHANNEL_ID` (`C...`/`G...` only) validation and setup-wizard
   collection, including a label lookup after the Slack tokens are available.
2. Replace the `channels` table and channel-policy configuration with a
   singleton gateway/session settings record. Retain the trusted-user,
   message-queue, scheduler, and archive data needed by the single session.
3. Ship a schema migration that never selects a legacy channel automatically.
   Require every operator to rerun setup and explicitly select the configured
   channel; do not infer it from a main flag, a sole registration, or row order.
4. After explicit setup selection, migrate that channel's folder and overrides
   into singleton settings without moving its session directory. Preserve its
   queued messages and mark queues for discarded channels failed with an audit
   log.
5. Simplify `RegisteredChannel`, channel-settings computation, session paths,
   queue claiming, scheduler task ownership, and all call sites to remove
   `jid` routing and per-channel state.

### 2. Limit Slack ingestion to the configured conversation

1. In `src/slack/client.ts`, reject events from DMs and events whose channel
   ID differs from `SLACK_CHANNEL_ID` before attachment processing or queue
   insertion.
2. Keep current bot-loop prevention, trusted-user checks, message/thread
   handling, busy reactions, attachment limits, and thread replies.
3. Require an explicit `@pi` mention for every inbound request. Remove
   automatic DM/channel registration, channel-name discovery,
   unregistered-channel notices, policies, and trigger-name configuration.
4. Make outbound responses and file sends derive the destination from the
   configured conversation. Thread timestamps remain explicit so replies land
   in the originating thread.

### 3. Replace slash controls with CLI controls

1. Extract reusable session-control services from `src/slack/commands.ts`:
   effective status formatting, model catalog/listing, fuzzy model selection,
   thinking validation/clamping, session rotation, and queue cancellation.
2. Add the `session` CLI command group described above, with strict argument
   validation and stable human-readable output. Remove `channels`, `register`,
   and `unregister`; remove `--channel` from `send` and scheduled-task creation.
3. Use a SQLite-backed control-request record for `session stop` and
   `session new`. A CLI process cannot reach the running gateway's in-memory
   abort controller, so the queue loop must consume requests, abort safely,
   clear pending work, and persist the result for CLI feedback.
4. Include the exact configured-session commands and current thread send
   command in the prompt injected by `src/agent/queue.ts`, so pi can perform
   every former `/pi` action when asked.

### 4. Remove Slack command/UI integration

1. Delete `src/slack/commands.ts`, `src/slack/panel.ts`, and their tests.
2. Stop registering commands/actions in the Slack client and remove unused
   Slack Block Kit type dependencies.
3. Remove the `/pi` slash-command declaration, `commands` OAuth scope, and
   interactivity setting from `manifest.yaml`. Document that existing Slack
   apps need their manifest updated and reinstalled if Slack requests it.

### 5. Update docs, tests, and release notes

1. Rewrite setup, configuration, CLI reference, security, session, scheduler,
   and file-transfer documentation around one configured conversation.
2. Replace `/pi` examples with agent requests and CLI examples. State that
   session control is performed by pi through the local CLI.
3. Add migration tests for zero, one, and multiple legacy registrations;
   config/setup validation; configured-channel filtering; ignored DMs and
   other channels; singleton session behavior; CLI parsing; control-request
   completion; and prompt instructions.
4. Remove channel-policy, registration, panel, and slash-command tests.
5. Run formatting, linting, unit tests, build, and a manual Socket Mode smoke
   test against the configured channel before release.

## Compatibility and rollout

This is a breaking configuration and CLI change. Release it as a major
version, retain a migration note in the changelog, and require operators with
multiple existing channels to choose the one conversation to keep before
upgrading. Do not remove old session archives during migration.
