# Ship readiness plan

## Status

**Not ready to ship.** Automated checks pass on the current machine, and most Linux/public/private Slack smoke tests have been exercised, but several live-validation failures violate the single-conversation contract. Two destructive/boundary checks also remain outstanding.

This plan records the remaining work found during code review and live validation on 2026-07-28. Complete the sections in order. Do not publish merely because the original automated acceptance tests are green.

## Supported release scope

This alpha supports Linux with a systemd user manager only. macOS/launchd is unvalidated and explicitly out of release scope. Package metadata, user documentation, release notes, and validation claims must continue to state Linux-only support until a future release restores macOS as a tested platform.

## Current validated baseline

The following passed from the current tree:

- `pnpm install --frozen-lockfile`
- `pnpm audit --prod`
- `pnpm format:check`
- `pnpm lint`
- `pnpm test` (213 passed, 1 skipped in the manager run)
- `pnpm build`
- CLI help smoke test
- `pnpm pack --dry-run`
- Linux systemd install/start/status/log/stop/uninstall
- Public and private Slack conversation metadata and bot-membership validation
- Public and private Socket Mode admission
- Mentioned text, attachment-only, actual edit, deletion, and mentioned thread-reply ingestion
- Unmentioned top-level message rejection
- Live history/message/thread reads and pagination
- Live file download, text send, and thread send
- Idle prompt, active follow-up, pi crash/restart, and no automatic Slack post
- Active reset, stale challenge, archive creation, and aggregate recovery prompt
- Journaled ordinary setup/reset, backup creation, and online/offline doctor

The gateway was restored to the original public conversation after private-channel testing and was left healthy. Reset backups preserve the prior public and private test states.

## P0: fix failures found by live validation

### 1. Ignore synthetic parent updates caused by thread activity

**Observed failure:** An unmentioned thread reply was added and deleted before a later mentioned reply. Slack emitted a synthetic parent `message_changed` event. The gateway advanced the accepted parent inbox revision despite unchanged source content and notified pi. This lets unmentioned thread activity indirectly wake pi and produced extra run sequences.

Required change:

- Distinguish substantive source edits from Slack parent metadata updates caused by reply count/latest-reply changes.
- Compare the persisted source snapshot fields that the gateway owns: content and attachment metadata.
- If an open accepted message has no substantive snapshot change, acknowledge the delivery without inbox mutation, reaction work, or pi notification.
- Decide and document whether the no-op event is ledgered. Preserve the invariant that retries cannot later mutate or notify.
- Do not weaken handling of real edits, deletions, or mentioned thread replies.

Acceptance tests:

- [ ] An unmentioned thread reply plus Slack's synthetic parent update creates no inbox item, parent revision, or pi notification.
- [ ] Deleting that unmentioned reply also causes no parent mutation or notification.
- [ ] A mentioned thread reply creates exactly one inbox item and one notification.
- [ ] A synthetic parent update adjacent to a mentioned reply does not produce a second notification.
- [ ] A real parent text edit without a fresh mention still advances exactly one revision and notifies once.
- [ ] Attachment additions/removals on a real accepted source are treated as substantive edits.

### 2. Make live V2 multi-file upload return success correctly

**Observed failure:** `slack send --file ... --file ...` uploaded both files and posted the message, but the control response was `SLACK_ERROR`. `uploadTimestamp()` did not understand the real `files.uploadV2()` response shape.

Required change:

- Capture and model the real Bolt/Web API v8 V2 multi-file result shape without logging tokens, private URLs, or file content.
- Extract the posted message timestamp from every supported successful response shape.
- Runtime-validate the result rather than treating an undocumented field as guaranteed.
- If Slack confirms upload completion but does not return a message timestamp, return a truthful success result that the public contract can support, or perform a bounded identity lookup that cannot select an unrelated message.
- Never tell the caller the upload failed after Slack has confirmed success.
- Preserve `OUTCOME_UNKNOWN` for transport ambiguity and `PARTIAL_SUCCESS` where Slack success is followed by a local persistence failure.

Acceptance tests:

- [ ] A fixture matching the captured live V2 multi-file response returns success and the correct timestamp.
- [ ] Single-file and multi-file uploads both return success.
- [ ] A thread upload returns the thread message timestamp.
- [ ] Malformed successful responses fail safely without encouraging a blind duplicate upload.
- [ ] Live text, thread, single-file, and multi-file sends all return success and appear exactly once.

### 3. Make active reset genuinely cancel on pre-flush disconnect

**Observed failure:** The service was frozen, a complete active-reset confirmation was queued, the client disconnected, and only then was the service thawed. The daemon still reset the session. A local socket write callback only proves transfer to the kernel, not that the peer remained connected to receive the response.

Required change:

- Keep the control client write side open while awaiting the response instead of calling `socket.end()` immediately after the request frame.
- Let the server observe an actual peer close while a reset reservation is pending.
- Cancel the reservation on close/error before the confirmation response has been successfully delivered according to the revised protocol boundary.
- Preserve one request and one response frame; do not add an unrestricted second command frame.
- If kernel-level flush still cannot establish the required guarantee, introduce a narrow correlated receipt handshake or revise the product contract explicitly before release. Do not claim a guarantee the Unix stream protocol cannot provide.
- Ensure all cancellation paths release the coordinator lane exactly once.

Acceptance tests:

- [ ] Freeze server, send confirmation, disconnect client, thaw server: no reset occurs.
- [ ] Disconnect while pi status validation is pending: no reset occurs.
- [ ] Successful CLI confirmation prints the response before child termination starts.
- [ ] Wrong, stale, settled, and replaced-run challenges do nothing.
- [ ] Cancellation cannot deadlock later Slack, scheduler, task, or control work.
- [ ] Successful confirmation still archives once and emits one aggregate recovery summary.

### 4. Persist a service-safe pi executable

**Observed failure:** Setup persisted `pi_binary = "pi"`. It worked in the interactive shell but systemd repeatedly failed with `spawn pi ENOENT` because the user manager did not inherit the pnpm bin directory.

Required change:

- During setup, resolve the selected/default pi executable through the setup process PATH.
- Persist a canonical absolute executable path after validating ownership/type/executability as appropriate for the daemon-account boundary.
- Reopen the staged and installed database and verify that exact resolved path.
- Interactive setup should display the resolved executable before installation.
- Decide how an intentionally relative `--pi-bin` is handled; rejecting it with guidance is preferable to storing a service-dependent value.
- Keep the persisted executable independent of the invoking shell's PATH so the systemd service can start reliably.

Acceptance tests:

- [ ] Setup with no `--pi-bin` resolves and persists the executable's absolute path.
- [ ] Setup with a PATH-only pnpm installation starts successfully under a minimal systemd PATH.
- [ ] Missing, non-file, non-executable, and unsafe paths fail before staging state.
- [ ] The generated systemd unit starts without adding the caller's whole PATH.

## P0: close previously identified contract gaps

### 5. Recover safely when post-commit Socket Mode acknowledgement fails

`src/slack.ts` commits admission, awaits acknowledgement, and only then starts reaction/pi effects. If acknowledgement rejects, durable work exists but effects do not run. Slack's retry is a duplicate and intentionally cannot repeat effects, so the item may remain unwoken until restart.

Required change:

- Define the durable post-admission side-effect state explicitly.
- Ensure an acknowledgement transport failure cannot permanently suppress receipt reconciliation or pi notification.
- Preserve the rule that duplicate deliveries never cause a second notification/reaction.
- Add a test with commit success followed by acknowledgement rejection and retry.

Acceptance tests:

- [ ] Commit success plus ack rejection eventually produces exactly one reaction attempt and one pi notification.
- [ ] Retry remains duplicate-safe.
- [ ] Crash at each commit/ack/effect boundary converges after restart without replaying accepted work twice.

### 6. Return `OUTCOME_UNKNOWN` for mutation disconnects

`src/cli/index.ts` maps mutation timeout correctly, but socket error/EOF after request delivery can become `DAEMON_UNAVAILABLE` or `INVALID_RESPONSE`.

Required change:

- Track whether the mutation request may have reached the daemon.
- For `slack.send` and `inbox.respond`, map timeout, post-write disconnect, EOF, and unusable response after delivery to `OUTCOME_UNKNOWN`.
- Include the generated request ID and inspect-before-retry guidance.
- Keep pre-connect failures as `DAEMON_UNAVAILABLE`.

Acceptance tests:

- [ ] Refused connection returns `DAEMON_UNAVAILABLE`.
- [ ] Disconnect before request write completes has deterministic safe classification.
- [ ] Disconnect/EOF after mutation write returns `OUTCOME_UNKNOWN` with request ID.
- [ ] Non-mutation commands retain their existing deadline/protocol classifications.

### 7. Preserve stable archive filesystem error codes

`session-archive.ts` emits `ARCHIVE_UNAVAILABLE`, `ARCHIVE_CREATE_FAILED`, and `ARCHIVE_CLEANUP_FAILED`, but the control error allowlist does not expose all of them, causing expected failures to become `INTERNAL`.

Required change:

- Add safe public mappings for expected archive errors.
- Keep local paths and underlying filesystem details out of responses.
- Add route-level tests, not only direct archive-function tests.

### 8. Finish persistence coupling constraints

Required change:

- Require `rpc_accepted_at`, `pi_session_id`, and `run_sequence` to be either all null or all present for accepted Slack events/tasks.
- Align runtime row validators with the database constraint.
- Validate Slack timestamp fields as decimal Slack timestamps where practical.
- Add negative schema and application-read tests.

## P1: stabilize and strengthen the release gate

### 9. Remove reset-test timeout flakiness

The manager's full run passed, but concurrent independent runs exceeded Vitest's default five-second per-test timeout in exhaustive reset failure-injection tests.

Required change:

- Give explicitly exhaustive filesystem tests a justified per-test timeout, or reduce redundant setup cost.
- Keep assertions exhaustive; do not fix this by dropping failure boundaries.
- Run the suite repeatedly under CI-like load.

Acceptance gate:

- [ ] Five consecutive `pnpm test` runs pass.
- [ ] A parallel CPU/I/O load run passes.
- [ ] Node 22 and Node 24 CI jobs pass.

### 10. Tighten CLI usage errors

- Map unsupported CLI commands to a concise stable usage/unknown-command error rather than `INTERNAL` plus the complete help text.
- Preserve exact JSON failure shape and stderr-only human failures.

### 11. Put every automated ship gate in the publishing path

The tag release workflow currently runs build/test but omits format, lint, production audit, CLI smoke, and package verification.

Required change:

- Make publish depend on an equivalent successful CI commit, or repeat all required gates in the tag workflow.
- Ensure tag builds cannot bypass the plan's automated release gate.

## Remaining manual validation

Repeat affected live tests after fixes; prior passes do not validate changed code.

Linux and Slack:

- [ ] Re-run public mentioned text, attachment-only, real edit, deletion, unmentioned thread activity, and mentioned thread reply.
- [ ] Prove one user action causes one intended inbox mutation/notification.
- [ ] Re-run live single/multi-file upload and confirm successful control responses.
- [ ] Re-run active reset success, forced disconnect, stale challenge, and recovery summary.
- [ ] Re-run systemd lifecycle from a fresh setup using default pi executable discovery.
- [ ] Exercise a live `RESPONSE_TOO_LARGE` result. Use a disposable channel/workspace fixture rather than flooding the normal channel.
- [ ] Exercise interrupted-reset recovery through plain `setup` in an isolated data/config directory, then verify bundle hashes, journal cleanup, and restored WAL-resident state.

macOS/launchd is not a release gate for this Linux-only alpha. Do not advertise or declare macOS package support until its lifecycle and Slack matrix are added back to a future plan and validated.

## Release mechanics

Only after all P0/P1 and manual gates pass:

1. [ ] Attach the detached HEAD commits to `docs/single-channel-refactor-plan` (or a replacement release branch) and push them. The named branch currently trails the reviewed HEAD.
2. [ ] Rebase/merge the latest `main` and rerun the complete gate.
3. [ ] Bump `package.json` and `pnpm-lock.yaml` from already-published `0.1.3` to the intended breaking alpha version.
4. [ ] Replace the changelog's `Unreleased` heading with the version and release date; include the hard cut, reset requirement, manifest reinstall, and alpha limitations.
5. [ ] Reapply and verify `manifest.yaml` in the release Slack app.
6. [ ] Run:

   ```text
   pnpm install --frozen-lockfile
   pnpm audit --prod
   pnpm format:check
   pnpm lint
   pnpm test
   pnpm build
   node dist/cli/index.js help
   pnpm pack --dry-run
   ```

7. [ ] Inspect the tarball contents and executable mode.
8. [ ] Confirm the release tag exactly matches `package.json`.
9. [ ] Publish the alpha/prerelease tag first if operational confidence is still limited.
10. [ ] Verify the npm install, CLI help, setup, and daemon lifecycle from the published artifact on a clean Linux account with a systemd user manager.

## Definition of shippable

This branch is shippable only when:

- no unmentioned Slack action can indirectly mutate accepted work or wake pi;
- every successful Slack mutation returns success, while ambiguous mutations return `OUTCOME_UNKNOWN` with correlation guidance;
- an active reset cannot occur after a confirmed pre-flush client disconnect;
- default setup starts under a real systemd environment without PATH repair;
- Socket Mode commit/ack/effect failures converge without loss or duplication;
- persistence and public error contracts match the documented invariants;
- automated tests are repeatably green under supported Node versions;
- all affected Linux/systemd and Slack checks pass;
- release versioning, branch refs, changelog, manifest, and publish workflows are ready.
