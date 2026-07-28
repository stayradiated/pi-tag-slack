# Changelog

## Unreleased — breaking single-conversation release

This alpha release hard-cuts to one configured public/private Slack conversation and one daemon-owned persistent pi RPC session.

### Breaking changes

- Slack admission now requires the configured `C...` or `G...` conversation, a trusted sender at event time, and a real bot mention on every new message and thread reply.
- Runtime interaction is through the daemon-owned inbox, task, schedule, Slack, trust, configuration, and session CLI groups. Pi output remains session-local unless pi explicitly uses `slack send` or `inbox respond`.
- Bootstrap configuration is limited to Slack tokens and the `PI_TAG_SLACK_CONFIG` / `PI_TAG_SLACK_DATA_DIR` deployment path overrides. Operational settings are persisted by the gateway.
- The Slack app manifest has changed. Reapply `manifest.yaml`, then reinstall/approve the Slack app.

### Required migration

1. Stop the old daemon/service.
2. Preserve the old data directory, bootstrap config, and session directories. Never delete legacy sessions or reset backup bundles.
3. Install this release and run the new `pi-tag-slack setup` for the intended conversation and initial trusted user.
4. Reapply `manifest.yaml` and reinstall/approve the Slack app.
5. Reinstall and start the service:

   ```bash
   pi-tag-slack daemon uninstall
   pi-tag-slack daemon install
   pi-tag-slack daemon start
   ```

This release does not migrate or silently adopt prior gateway state. `setup --reset --yes` is an explicit replacement operation and creates a backup bundle; it is not a cleanup instruction.

## Earlier releases

Earlier alpha releases used a different deployment model and are not compatible with this release. Preserve their data for rollback; do not expect this daemon to adopt it.
