# Synthetic legacy DAG attempt history

`dag-attempt-legacy.json` was captured on 2026-10-19 from `dagMissionWorkflow` at
`9748a4b` (before `dag-attempt-restart-resume-v1`), with synthetic Activities: one
node `n1`, whose `runDagAttempt` threw a retryable `SyntheticWorkerLoss`. Under the
old `maximumAttempts: 1` policy the node escalated `NODE_EXECUTION_ERROR`. No Agent
was started; payloads contain only the synthetic mission/task IDs and outcomes.
Worker and client identities are replaced with `synthetic-worker` / `synthetic-client`.

`dag-attempt-restart.test.ts` replays it under current code to prove the patch keeps
old histories deterministic. Same protobuf-native JSON layout as
`mission-followups-legacy.json`: deserialize with `History.fromObject`.
