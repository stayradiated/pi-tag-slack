# Ship readiness plan

## Status

**Not ready to ship.** The current tree closes several automated gaps, but live/manual validation, supported-version CI, and release mechanics remain incomplete. Most importantly, pi cannot currently provide exactly-once notification across its accept-before-local-mark boundary; this is a ship blocker.

## Scope and evidence

This is a Linux/systemd-user-manager alpha only. macOS/launchd is out of scope and must not be advertised as supported.

Recorded local validation for this tree:

- five `pnpm test` runs on Node 26 and one parallel CPU/I/O load run passed;
- the Node-26 evidence is useful flake coverage, **not** supported-version CI;
- Node 22 and Node 24 CI have not run.

The normal release commands and all live Slack/systemd checks below must be rerun after the pending work; none is implied by the local evidence above.

## P0 automated work

### 1. Synthetic thread-parent updates

Implemented and covered in `test/slack-ingestion.test.ts`.

- [x] Unmentioned replies and their added/deleted synthetic parent updates leave no inbox mutation, revision, reaction, or pi notification.
- [x] Mentioned replies create one accepted item/notification; adjacent synthetic parent updates do not add another.
- [x] Real parent text edits and attachment additions/removals remain substantive and notify once per accepted revision.

Synthetic no-ops are deliberately **not ledgered**. On retry, the gateway compares the owned content/attachment snapshot again; the unchanged delivery remains inert and cannot later mutate or notify.

### 2. V2 file-upload results

Implemented and covered in `test/slack-upload-response.test.ts` and gateway upload tests.

- [x] The captured nested Web API v8 multi-file completion shape returns its message timestamp.
- [x] Flat single-file and multi-file responses, including thread shares, return the correct timestamp.
- [x] Ambiguous/malformed successful completions use a bounded exact-file-ID lookup or return `OUTCOME_UNKNOWN`, rather than inviting a blind duplicate; explicit Slack rejection remains distinct.
- [ ] Live text, thread, single-file, and multi-file sends return success and appear exactly once.

### 3. Active-reset delivery boundary

The control protocol now uses a narrow correlated receipt after the confirmation response; reset starts only after that receipt. Coverage is in `test/control-reset-receipt.test.ts` and `test/session-controls.test.ts`.

- [x] Close before the receipt cancels the reservation, performs no reset, and releases the coordinator lane.
- [x] A confirmed reset is dispatched once, and reset starts only after the response is consumed and receipted.
- [x] Stale confirmations are rejected by session-control tests.
- [ ] Exercise the frozen-server/pre-flush-disconnect and pi-status-pending cases against the real daemon.
- [ ] Re-run live archive-once and aggregate-recovery-summary behavior.

### 4. Service-safe pi executable

`test/setup-validation.test.ts` and `test/setup-interactive.test.ts` cover canonical PATH resolution, rejection of relative/unsafe inputs, persistence/reopen validation, and interactive display.

- [x] Setup resolves the default command to a canonical absolute executable and persists/reopens that value.
- [x] Missing, non-file, non-executable, relative-path, and unsafe executable inputs fail before staging.
- [ ] Verify a PATH-only pnpm installation starts under a minimal real systemd environment without caller PATH injection.

## P0 unresolved ship blocker

### 5. Socket Mode acknowledgement/effect recovery is not exactly once

The tree durably reconciles post-admission effects across acknowledgement rejection and restart; `test/slack-ingestion.test.ts` covers duplicate-safe acknowledgement failure and pending-effect recovery. That is not sufficient to close this item.

**Blocker:** pi can accept a notification before the gateway records its local acceptance metadata. A crash in that interval leaves no durable local proof of pi acceptance; recovery/retry can notify pi again. Conversely, suppressing retry can lose the accepted work. The gateway cannot establish exactly-once behavior at this boundary by itself.

- [ ] Item 5 remains open. Do not claim convergence without loss or duplication across the pi accept-before-local-mark boundary.
- [ ] Obtain upstream pi idempotency/correlation support, or revise the product contract to an explicitly at-least-once/at-most-once guarantee, then add boundary crash tests.

### 6. Mutation disconnect outcomes

Covered in `test/control-cli-contract.test.ts`.

- [x] Pre-connect refusal remains `DAEMON_UNAVAILABLE`.
- [x] EOF/unusable response after a mutation may have been delivered returns correlated `OUTCOME_UNKNOWN`; read-only commands retain protocol classification.
- [ ] Prove and document the intended classification for disconnect before request write completion.

### 7. Archive errors

- [x] `test/archive-control-cli.test.ts` proves sanitized public route mappings for archive filesystem errors; paths and underlying details are not exposed.

### 8. Persistence coupling

- [x] `test/persistence-control-validation.test.ts` proves schema and application validation require `rpc_accepted_at`, `pi_session_id`, and `run_sequence` to be all null or all present, and rejects invalid decimal Slack timestamps.

## P1 automated work

### 9. Reset-test stability

- [x] Five Node-26 suite runs passed.
- [x] One parallel CPU/I/O load run passed.
- [ ] Node 22 CI passes.
- [ ] Node 24 CI passes.

### 10. CLI usage errors

- [x] `test/control-cli-contract.test.ts` proves unsupported commands return a concise stable unknown-command error rather than `INTERNAL` plus full help.

### 11. Release workflow gates

- [x] `.github/workflows/release.yml` now runs production audit, format check, lint, test, build, CLI help smoke, and package dry-run before publishing.
- [ ] Verify the amended workflow in CI; publishing/tag mechanics remain unperformed.

## Remaining manual validation

All are release gates and remain unchecked:

- [ ] Re-run public mentioned text, attachment-only, real edit, deletion, unmentioned thread activity, and mentioned thread reply; prove one action causes one intended mutation/notification.
- [ ] Re-run live text/thread/single-file/multi-file sends and confirm one successful control result and one Slack message each.
- [ ] Re-run active-reset success, forced disconnect, stale challenge, archive, and recovery summary.
- [ ] Fresh setup with default pi discovery, then full Linux systemd install/start/status/log/stop/uninstall under a minimal service PATH.
- [ ] Exercise live `RESPONSE_TOO_LARGE` with a disposable fixture.
- [ ] Exercise interrupted-reset recovery through plain `setup` in isolated paths; verify bundle hashes, journal cleanup, and WAL-resident restoration.

## Release mechanics

All remain unchecked: attach/push the release branch, merge/rebase current `main`, bump version and lockfile, finalize changelog, reapply/verify the Slack manifest, run and inspect the full release gate/tarball, create/verify the tag, publish the prerelease, and validate the published artifact on a clean Linux systemd account.

Required gate:

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

## Shippable only when

The pi exactly-once blocker is resolved by upstream idempotency/correlation or an approved product-contract revision; supported Node 22/24 CI, all manual Linux/Slack checks, and every release mechanic above are complete.
