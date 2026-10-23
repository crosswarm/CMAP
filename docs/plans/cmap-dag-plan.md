# CMAP deterministic DAG execution — draft v3

## Requirements and evidence

The existing Mission API runs inspect/v1 only (apps/control-plane-api/src/mission-submission.ts:20-35; schemas/mission-create.v1.schema.json). mission.workflow.ts:84-180 implements one logical task plus rework. TaskRecord.deps, Store.findReadyTasks (since deleted as unused in 872ed54) and PgStore dependency persistence exist (packages/domain-model/src/entities.ts:68-86; store.ts:176-181). Those are reusable building blocks, not proof of a DAG scheduler. Real Codex/Kimi execution, independent evidence hashes and per-task result normalization are already delivered. P4 and YonWork remain separate goal requirements.

Deliver explicit-plan execution from API through Temporal, actual adapters, dependency artifacts and UI observation. Do not claim automatic natural-language Planner integration; external planners/clients supply the typed plan. Implementing that Planner bridge remains a separately tracked project requirement rather than silently dropping it.

## RALPLAN-DR

Principles: preserve inspect histories; schema/graph validation before side effects; identities/authorization/evidence remain control-plane facts; completion means all declared criteria proven; reuse current adapters/Store/Temporal.
Drivers: dependency/rework correctness; compatible release boundary; independently testable real multi-agent execution.
Options:
A. Extend missionWorkflow in place into a universal scheduler: least duplication, but changes old histories and approval/mission aggregation together.
B. Add dag/v1 with a separate DAG Workflow, reusing Store/Adapter primitives and pure builders while leaving the legacy orchestration unchanged: explicit version boundary and clear driver ownership; some bounded orchestration duplication. Preferred.
D. Child Workflow per logical node is viable and gives strong cancellation/history isolation, but adds lifecycle/operational complexity for at most 32 nodes; defer unless one parent history becomes a measured ceiling.
C. Represent every node as a separate Mission: reuses old workflow wholesale, but splits one objective/approval/evidence ledger and falsely completes child Missions before global acceptance; rejected as wrong domain boundary.
Tension: upfront materialization helps UI, but physical dependency IDs become stale after rework. Prefer create-ready materialization using accepted predecessor final Task IDs; plan nodes without tasks remain visibly pending in the plan view.

## Contract

Add mission-plan.v1 schema, optional plan in existing creation request, and dag/v1 template. Keep old requests unchanged. Plan max 32 nodes; concurrency 1..4 (default 2). Each logical node has stable node_id, goal, capability, deps, criterion_ids (references to existing Mission acceptance), risk_level, required_resource_locks (resource and ttl_seconds), and explicit preferred/fallback routing when requested. Require nonempty criterion_ids per node and a nonempty finite acyclic graph, unique IDs/deps, no missing/self edges, and every Mission criterion assigned exactly once. Node criterion IDs resolve to the unchanged metric/operator/expected/hard_gate definition. Do not let plan authors inject owner/tenant, remote bindings or approval decisions. For DAG requests the caller risk_level is an executable Mission ceiling: reject any node above it before Store writes, using the existing four-level risk order only for ceiling comparison. Each node still requests its own controlled or mutating scope approval; a mutating Mission ceiling does not grant controlled permission or any action. The ceiling is not an authorization grant.

Persist validated plan in immutable Mission input/constraints and derive workflow_template=dag/v1. Request-key idempotence includes the complete plan and defaults; array order is explicitly part of scheduling priority. Changing an existing request's plan returns 409. Workflow starts remain fixed-ID and DRAFT recovery chooses the stored template. Reject invalid plans before Mission/Task creation.

Task envelope gains optional logical plan node identity. Node Task and Review identities are Activity-generated and deterministic per Mission/node/attempt (and review round). Both MemoryStore and PgStore must implement conflict-checked idempotence: same immutable input returns the existing record without state/reset/event duplication; changed immutable input throws a conflict. Stable IDs alone are not sufficient. Ignore creation timestamps and mutable state/result when comparing the original immutable input. Increment both TaskRecord.attempt and envelope revision on successor attempts. Existing TaskRecord.deps records accepted predecessor FINAL Task IDs, not initial attempts. Before materialization, reread an accept Review matching the final Task and verify its hard criteria/result; COMPLETED state alone is insufficient because old reworked attempts also become COMPLETED. Per-node successor tasks preserve that node's criteria, risk, routing and inputs rather than reverting to whole-Mission fields.

## Execution

A separate dagMissionWorkflow owns graph readiness. Register both workflows through a stable export module and choose the stored template on create/resume. Leave missionWorkflow orchestration unchanged in this milestone, reusing pure builders/Store/Adapter primitives, not extracting its loop yet. Run ready nodes in declared order with bounded concurrency. Define NodeOutcome = accepted | rework | failed | escalated, with node ID, attempt/final accepted Task ID and causal code. DAG-specific node review effects must never write global Mission terminal state. Exactly one finalizeDagMission Activity rereads the complete plan, Task/Review facts and criterion coverage before a terminal write. Mission precedence: any escalated node or lock loss => ESCALATED; otherwise any rejected/failed node => FAILED; COMPLETED only when every node has a proven accepted final attempt and every Mission criterion is covered once. Preserve and replay old success/rework/approval histories.

Only materialize a node after its dependencies are accepted. Bind to their final successor Task IDs and pass ALL AVAILABLE artifacts from direct accepted dependencies; no new selection language in v1. Control-plane materialization copies verified input bytes into the child workspace under namespaced input paths, retaining source IDs/hashes; it never passes unchecked host paths, accepts symlink escape, or rereads bytes after hashing for the copy. Input copy retries verify an existing target has identical bytes; a different target conflicts rather than overwriting evidence. Extend the shared prompt renderer to expose inputs.artifact_refs as controlled namespaced paths and hashes. Child mutation cannot modify upstream originals. Missing/tampered input evidence fails the node clearly.

An escalated/failed predecessor prevents descendants from dispatching; independent already-started branches settle and retain evidence. Stop launching new work after fatal/escalated outcome. Surface blocked node IDs with causal predecessor references, then terminal Mission FAILED or ESCALATED as appropriate. Never claim success from a subset. DAG Mission remains RUNNING while branches are active/waiting; individual task/approval states show required action. Only driver owns global terminal writes, avoiding parallel approval toggles.

One DAG attempt Activity owns explicitly declared resource locks and the running Agent lifecycle. The then-existing acquireTaskLock Activity (since deleted in 872ed54; never used by the DAG path) changed Task state to RUNNING, so it cannot simply precede dispatchTask (which transitions to QUEUED). Use Store lock primitives inside the attempt owner without premature state transitions: sort/acquire all resources, release partial acquisition on contention, return a contention outcome to deterministic Workflow sleep/retry; approval occurs before lock holding. Copy declared resource/TTL policy into the envelope and actually honor it. While polling, renew owned leases; on loss cancel the owned attempt and observe terminal status with a fixed 5-second cancellation grace period. Confirmed terminal/cancellation releases all still-owned locks immediately. If terminal state is unconfirmed after the grace period, stop renewals and retain remaining leases until their TTL expires (do not voluntarily release them); return escalated with CANCELLATION_UNCONFIRMED and never claim the process stopped. Lock loss itself escalates the node because exclusivity is no longer provable. Hard process/host death remains the ADR-0004 residual boundary, not a new claim of complete fencing. Test both supported adapters' owned-process cancellation before claiming lock-loss stopping works.

Reviewer currently generates one successor per automatic round. For DAG node execution, enforce exactly one logical successor for this first version; an unsupported multi-followup decision must fail/escalate BEFORE creating any successors, never create/discard extra tasks. Track general reviewer-driven graph expansion as a follow-up capability.

## Delivery sequence

1. Schema/codegen/semantic validation and negative contract tests. Add immutable plan input comparison. No execution from invalid plan.
2. Conflict-checked idempotent Task/Review Store semantics, node materialization with stable IDs, acceptance/routing inheritance, accepted-Review predecessor deps and verified artifact input transfer. Memory+PG shared contracts, concurrent creation, and partial retry tests.
3. DAG-safe review/outcome and single-attempt lock-owner Activities plus DAG driver, bounded readiness, failure aggregation, approvals and rework. Preserve inspect orchestration and replay its histories before continuing.
4. API creates/starts correct stored template; existing UI execution view shows plan nodes, dependencies, latest attempts, waiting/blocked/terminal outcomes. Acceptance projection resolves each criterion through its owning node and proven accepted/latest attempt; never reuse the globally newest Task for all criteria. No new UI library or separate scheduler service.
5. Real API→Temporal DAG with independent Codex/Kimi branches and a join consuming their actual evidence; verify counts, hashes, identities, no early join, no premature global completion, and replay the resulting history.

## Acceptance and verification

See test-spec-cmap-dag.md. No fake-only completion claim. Keep implemented/pushed/deployed distinct. No production deployment in this lane.

## Risks and mitigations / pre-mortem

1. Reworked parent stays REWORK and child waits forever: dependency logical state resolves to final accepted attempt; tests force one rework before join.
2. A parallel child completes the whole Mission early or one failed branch is hidden: global driver owns terminal state; test one accepted + one failed + blocked join.
3. Graph side effects repeat after retry, or locks/evidence escape: deterministic materialization IDs, retry-conflict tests, loss-of-lock cancellation and tampered artifact/native path tests.

## ADR draft

Decision: versioned DAG Workflow, shared Store/Adapter primitives with unchanged legacy orchestration, create-ready materialization.
Drivers/alternatives: above. Why: correctly separates logical graph nodes from physical rework attempts and global Mission state without inventing new services.
Consequences: UI must render planned-but-unmaterialized nodes; approval waits remain task-visible; any shared Activity change requires replay; legacy loop extraction is deferred. Follow-ups: natural-language Planner bridge, reviewer-driven dynamic graph expansion, YonWork and P4 admission/auth/transport. These remain on the full goal, not redefined away.

## Execution staffing / handoff

Available applicable native roles: explore, executor, architect, critic, test-engineer, verifier, researcher. Suggested 2 executor lanes (contract/materialization and workflow/API after contract), a bounded frontend lane after API, and independent verifier; parent owns integration, actual e2e and goal state. Use inherited models; high reasoning for workflow/state review, medium for bounded code/test lanes.

Recommended follow-up: existing Codex native goal with native subagents (App-safe equivalent of Team + Ultragoal). No new goal/thread is needed. In an explicitly requested OMX CLI/tmux environment only, launch hint: `omx team 2:executor "Implement approved cmap-dag plan and tests"`; leader checkpoints only after shared contract, replay and real e2e evidence. Native App does not launch tmux implicitly. Ralph is only an explicitly selected sequential fallback; research/performance goal modes are not needed for this implementation task.

Planning gate: await role-specific Architect then Critic sequentially. This draft is not execution approval. The existing user development authorization remains valid; after a complete planning handoff, the current goal supplies the execution lane without a new permission question.

## Revision v2 review changes

Applied Architect REVISE: accept Review (not merely COMPLETED) proves parent readiness; conflict-checked Task/Review idempotence in both stores; driver-only ledger-verified finalization and explicit outcome precedence; one lock-owning attempt Activity with correct Task transitions; all-direct-dependency artifact policy and prompt exposure; node-aware UI criteria; multi-followup rejection before writes. Preserved the independent dag/v1 boundary and deferred legacy orchestration extraction. Jev parent advisory favored versioned_dag (0.97); this is not the consensus gate.

Revision v3: made Mission risk ceiling a pre-write validation rule; specified confirmed-cancel immediate release vs unconfirmed-cancel retained leases until TTL, fixed 5-second grace, and explicit uncertainty outcome.
