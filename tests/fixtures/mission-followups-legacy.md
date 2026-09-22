# Synthetic legacy Mission history

`mission-followups-legacy.json` was captured from the pre-queue Workflow at
`d6ef2d2` with synthetic Activities. No Agent was started; all 31 payloads were
decoded and checked to contain only the synthetic root/child IDs, decisions,
progress and results. Worker identities are replaced with `synthetic-worker`.

The 113-event history declares `child-a` and `child-b`, but legacy code executes
only `child-a`. It protects historical replay, not that incorrect behavior for
new runs. `mission-followups.test.ts` separately proves both new children run.

The file uses protobuf-native JSON. Deserialize with the installed Temporal
protobuf `History.fromObject` before `Worker.runReplayHistory`; passing this
JSON directly selects Temporal's different proto3-JSON timestamp parser.
