# Runner admission test specification

Planning artifact only; no tests are claimed implemented or passing here.

## Required outcomes

| Case | Observable proof |
|---|---|
| Fully matching configured grant | Existing dispatch creates one binding and runs the selected declared Adapter |
| Missing or malformed policy | Worker rejects startup; no Temporal polling or Adapter side effects |
| Explicit empty allowlist | Schema-valid deny-all; present empty env list becomes []; no task can pass that dimension |
| Unknown tenant, owner, capability, risk | A separate test for each dimension; no Adapter discovery/health/start |
| Wildcard-looking grant | Rejected or exact nonmatching semantics as frozen Schema specifies; never wildcard authorization |
| Envelope disagrees with persisted Mission identity | Denied even when the forged envelope matches the allowlist |
| Envelope disagrees with persisted Task capability/risk/id | Denied before new execution |
| Wrong runner host affinity | Denied before directory creation or artifact access |
| Adapter outside configured runner agent inventory | No routing fallback to that Adapter |
| Admission risk ceiling permits controlled | Existing controlled Approval still required; mutating scope cannot substitute |
| DAG new node denied | No parent payload read/copy, child directory, binding or Agent process |
| Existing unbound DAG Task denied | No lease acquisition/assignment/start; explicit bounded denial outcome |
| Denial after preparatory async work but before intent | Final policy check prevents any new intent/send; no inferred authority from earlier check |
| YonWork denial after durable intent but before chat | Retain binding tombstone and intent; zero chat send, no retry resend; use legal terminal handling without claiming a remote terminal |
| Already bound task under revised policy | Observation, result collection and scoped cancellation work; no new send |
| Local config aliasing | Caller mutation cannot silently modify trusted policy during an in-flight decision |
| Ordinary exception after a possible send | Existing uncertainty/cancellation behavior retained, never reclassified as safe admission denial |
| Duplicate rejected operation | Replay phase/code receipt before binding fast path or fresh policy; return identical denial even after policy loosens |
| Crash after denial state/event commit | Both initial and post-intent retries reconstruct identical denial; post-intent retains binding and never enters result polling as success |

## Real-path gates

1. Isolated local API/Worker/Temporal/PG with explicit synthetic operator policy: real Codex allowed task completes with matching runner binding, independent artifact hash and ledger review.
2. Same stack with API owner not granted to Worker: mission/node reaches explicit escalation with bounded `RUNNER_ADMISSION_DENIED` reason, no binding, no child files, no Adapter launch. Retry exhaustion is not the expected outcome.
3. Exercise legacy Mission and DAG fork/join seams affected by the guard. Replay a pre-change real Mission history and a pre-change DAG history, plus new successful history; keep histories in memory/private temporary storage.
4. Run Node 24 typecheck/full suite/PG contract suite, schema codegen consistency and pre-commit checks.

Use injected synthetic grants only for test fixtures; never derive production grants from the incoming Task. A local configured runner id is not authenticated remote identity. P4 mTLS/OIDC/short tokens/remote storage remain outside this proof and inside the full goal.

New configuration inputs must be defined in `schemas/` and generated before tests/implementation. The rejection outcome must serialize through Temporal; tests must not depend on an Error prototype surviving an Activity boundary. Do not manufacture RUNNING/assignment merely to make a terminal state transition legal.
