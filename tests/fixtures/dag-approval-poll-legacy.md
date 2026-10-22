# Synthetic legacy DAG approval-poll history

`dag-approval-poll-legacy.json` was captured on 2026-10-22 from `dagMissionWorkflow` at
`0da16c2` (before `dag-approval-signal-v1`), with synthetic Activities: one node `n1`
whose `checkDagApproval` returned `pending` three times (each followed by the old
1-second `sleep` poll) and then `approved`. No Agent was started; payloads contain only
the synthetic mission/task IDs and outcomes. Worker and client identities are
`synthetic-worker` / `synthetic-client`.

`dag-approval-signal.test.ts` replays it under current code to prove the patch keeps
old histories deterministic. Same protobuf-native JSON layout as
`dag-attempt-legacy.json`: deserialize with `History.fromObject`.
