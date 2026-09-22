# CMAP P4 runner admission — consensus draft

## Outcome and stop condition

Before any host-side preparation or Adapter call, CMAP must prove that the current locally configured `RunnerDescriptor.admission` permits the authoritative Mission/Task subject and host affinity. Initial denial must leave no binding, locks, copied DAG input or Agent process. A post-intent YonWork revocation must retain its tombstone binding, send zero chat and never resend. Stop only after real allowed and denied API→Temporal→Worker runs prove these outcomes.

This does not complete P4 or the full user goal. It makes one existing security contract real without pretending `RUNNER_ID` authenticates another host.

## RALPLAN-DR

### Principles

1. Persisted control-plane identity outranks task self-description.
2. Host admission is default-deny, exact-match and precedes side effects.
3. Reuse the existing descriptor/schema and shared execution seams.
4. Local compatibility is explicit configuration, never an implicit bypass.
5. Model advice cannot grant authority; code and tests decide admission.

### Drivers

1. T1 prevents another tenant/owner from running code on this machine.
2. DAG artifact materialization already performs filesystem reads/writes before dispatch.
3. Remote identity/transport is not ready; a registry now would not authenticate anything.

### Options

| Option | Benefit | Cost / invalidation |
|---|---|---|
| A. Policy-only at actual host seams | Smallest slice that blocks effects now; reuses `RunnerDescriptor` | Local descriptor is configured, not remotely authenticated; selected |
| B. Registration plus policy | Durable inventory and heartbeat could later support routing | No remote authenticated consumer exists; registry would be unused authority and expand Store/API/schema |
| C. Transport-first | Establishes real workload identity | Leaves current local dispatch ungated longer and is too broad for this slice |

Jev favored A; repository evidence independently supports A.

## ADR

**Decision:** Add a minimal schema for normalized startup admission, then require one `RunnerDescriptor` in `ActivityDeps` and remove the independent `runnerId`. One pure predicate evaluates an explicit admission subject. Persisted paths derive that subject from Mission + Task and separately prove envelope consistency; pre-copy DAG derives it from persisted Mission + normalized plan node + deterministic task ID, independent of not-yet-known `artifact_refs`. Call it before DAG copy, before DAG locks, and before shared dispatch effects. Worker startup constructs a local descriptor only from operator-owned environment and configured Agent descriptors.

**Drivers:** earliest-effect safety, one policy implementation, no task-derived grants, no fake remote identity.

**Alternatives considered:** durable runner registry; WSS/mTLS/OIDC first; dispatch-only check; Adapter-local duplicated checks; optional local bypass. Rejected respectively as unused, oversized, too late, lacking Mission authority, and fail-open.

**Consequences:** Worker startup fails when policy is missing or invalid. Existing tests inject explicit synthetic descriptors. `RUNNER_ID` and `RUNNER_TENANT` remain configured local labels, not authenticated identity. P0-P3 works when API scope and Worker grants match. Remote admission still requires authenticated registration and transport.

**Follow-ups:** authenticated runner registration/heartbeat; WSS+mTLS and audience-bound tokens; OIDC owner identity; sandbox/path enforcement; remote artifacts; full T1-T12 acceptance.

## Implementation steps

1. **Freeze the startup contract and policy behavior with failing tests.**
   - Add `schemas/runner-admission.v1.schema.json`, wire `scripts/codegen.mjs` and `scripts/precommit-checks.mjs`, generate `packages/domain-model/src/generated/runner-admission.ts`, then add positive/negative cases to `tests/contract/schemas.test.mjs`.
   - Schema requires `schema`, `runner_id`, `runner_tenant`, `host`, exact allowlists for tenants/owners/capabilities (empty arrays are valid explicit deny-all) and `max_risk`; identifiers are trimmed bounded strings, wildcards/empty members/unknown fields are rejected. It contains no secrets, tokens, health claims or remote-auth fields.
   - Add `tests/domain/runner-admission.test.ts` and include it in `package.json` `test`/`test:domain`.
   - Test exact allow for matching persisted Mission + envelope; deny empty lists, unknown tenant, owner or capability, risk above ceiling, mismatched/missing envelope identity, host affinity mismatch and unhealthy runner.
   - Test no wildcard semantics and verify `controlled` admission does not imply a `mutating` Approval.

2. **Implement one reusable predicate over an authoritative subject.**
   - Add `packages/domain-model/src/runner-admission.ts`; export from `packages/domain-model/src/index.ts`.
   - Define a small immutable `RunnerAdmissionSubject` (`mission_id`, `task_id`, `tenant`, `owner`, `capability`, `risk`, optional `affinity_host`) and a typed safe denial code. The predicate accepts only `RunnerDescriptor` + subject.
   - Persisted builder accepts Mission + Task, validates Task fields and final envelope agree, then produces the subject. Pre-copy builder accepts persisted Mission + normalized plan node + deterministic task ID; it deliberately ignores artifact refs because verified copy creates them later.
   - Exact membership only; compare risk order using existing `RISK_LEVELS`; enforce affinity; clone/freeze policy arrays so caller mutation cannot change an in-flight decision. Never inspect task text or infer grants.

3. **Inject a single descriptor and gate every pre-execution seam.**
   - Change `ActivityDeps` in `workflows/activities.ts` from optional `runnerId` to required `runner: RunnerDescriptor`; derive all binding/lease actor IDs from `runner.runner_id`.
   - In `dispatchTask`, load Mission + Task and assert admission before `selectAdapter`, Task state transition, work-directory creation, `prepareBinding` or `startTask`. Restrict candidates to `runner.agents`, which are **Agent IDs**, never Adapter IDs; re-run against fresh persisted facts in YonWork `beforeSend`.
   - Pass the descriptor through `workflows/dag-activities.ts` and `workflows/dag-attempt.ts`.
   - In `workflows/dag-materialization.ts`, assert the candidate subject before any parent artifact read/copy or child directory creation; after copying, build/persist the final envelope and let dispatch perform the full persisted consistency check.
   - In `workflows/dag-attempt.ts`, recheck the existing unbound Task before lock policy evaluation/acquisition. A revoked Task acquires no lease.
   - Preserve recovery for already-bound work: admission revocation blocks new preparation/send, but `getStatus`, `collectResult` and scoped cancellation for the persisted binding remain callable so a prior run is never orphaned.

4. **Make local startup explicit and fail closed.**
   - Add `apps/worker/src/runner-config.ts` and `tests/tooling/runner-config.test.mjs`; parse env into the new normalized schema before constructing the descriptor.
   - Require existing `RUNNER_ID`, `RUNNER_TENANT`, `RUNNER_ALLOWED_TENANTS`, `RUNNER_ALLOWED_OWNERS`, `RUNNER_MAX_RISK`; add required `RUNNER_ALLOWED_CAPABILITIES` and optional `RUNNER_HOST` (default `os.hostname()`). Never fall back to `CMAP_TENANT`, `CMAP_OWNER` or Task fields. Reject missing variables and unknown/duplicate/wildcard or blank member values. An explicitly present empty allowlist variable normalizes to `[]` (deny-all); missing variables never grant access. Non-list identity/risk fields cannot be blank.
   - `apps/worker/src/main.ts` discovers configured Adapter descriptors at startup, validates identities, and builds `RunnerDescriptor.agents` from their `agent_id` values. Capability grants remain operator input; discovery never expands admission.
   - Update `.env.example` and `README.md`: align the local example owner with `local-operator`, list allowed capabilities, explain preview must use `test-harness:dag`, and label `RUNNER_ID`/local context as unauthenticated local configuration.

5. **Make each denial phase explicit, legal and replay-safe.**
   - Keep prior successful `DispatchOutput` / `{taskId}` shapes valid for old Temporal histories; add only JSON-serializable discriminated denial variants. Normalize missing discriminator as legacy success. Never serialize Error/class instances.
   - Initial denial before intent transitions an existing undispatched Task through a legal current-state edge to `CANCELED` with `TASK_CANCELED` and bounded `RUNNER_ADMISSION_DENIED:<CODE>`; it must not fake `RUNNING`, assignment or start. Candidate denial before Task creation returns the same bounded union with no ledger Task.
   - Post-intent/pre-send YonWork revocation is `RUNNING` with a durable tombstone binding. Keep the binding, transition legally to `FAILED_TERMINAL` with `TASK_FAILED`, emit `RUNNER_ADMISSION_REVOKED:<CODE>`, send zero chat; retries return the same persisted denial, never the ordinary binding-success path.
   - Persist a durable denial receipt using the existing state-transition transaction/event: deterministic idempotency key `runner-admission:<taskId>`, bounded `{phase,code}` payload, and the corresponding legal terminal state. No new table. Dispatch order is Task lookup → validate/replay this receipt → existing-binding recovery → fresh admission. A malformed matching receipt fails closed. A valid receipt always reconstructs the identical serializable denial even after policy changes; never infer admission denial from a generic terminal state alone.
   - Test crash after state+receipt commit but before Activity return for both initial denial and post-intent revocation. Retry must return byte-equivalent denial, perform no new prep/send, and preserve a post-intent binding. This receipt must outrank the ordinary existing-binding fast path.
   - Update `workflows/mission.workflow.ts`, `workflows/dag-attempt.ts` and `workflows/dag.workflow.ts` to turn confirmed denial unions into Mission/node `ESCALATED`. Keep ordinary exceptions after a possible send on existing uncertainty/cancellation handling.
   - The DAG materialization Activity catches only the typed admission error and returns the same bounded denial; all other exceptions retain current handling.
   - Extend `tests/workflow/dispatch.test.ts`: table-driven denials cause zero `discover`, `health`, `startTask`, binding, assignment/start events and work directory.
   - Extend `tests/workflow/dag-materialization.test.ts`: denied owner/capability/risk produces no child directory, copied payload or Task; allowed case remains idempotent.
   - Extend prepared-dispatch tests to distinguish initial denial from post-intent revocation: latter retains tombstone binding, sends zero chat, never resends, and remains collectable/cancellable.
   - Update all Activity fixtures to inject explicit synthetic descriptors; no test-only bypass.
   - Treat `.omx/plans/test-spec-cmap-p4-runner-admission.md` as the required negative/serialization/replay matrix.

6. **Run bounded integration and publish honest evidence.**
   - Node 24: `npm run typecheck`, targeted domain/workflow/tooling tests, `npm run check`, `npm run test:pg`, `git diff --check`.
   - Start isolated API/Worker scopes and run `node scripts/verify-temporal.mjs`.
   - Allowed: matching tenant/owner/capability/risk via API→Temporal→Worker→real Codex; verify binding runner ID, result/artifact hashes and replay (`scripts/e2e-dag.mjs` when DAG path changes).
   - Denied: API owner outside Worker allowlist; verify Workflow terminal failure/escalation is explicitly `RUNNER_ADMISSION_DENIED`, Task has no binding/events indicating dispatch, no child files, and Codex process count/log evidence shows no launch. Do not treat retry exhaustion as the admission signal.
   - Record sanitized results in `docs/verification-runner-admission-2026-09-22.md`; update `docs/architecture.md` and `docs/threat-model.md` T1 only to 🟡 “local gate implemented; authenticated remote identity pending.”

## Acceptance criteria

- All five admission dimensions are exact and default-deny; task fields alone can never grant access.
- Both legacy and DAG paths reject before any host-side file/process/session effect.
- DAG admission is checked before artifact copy and before lease acquisition.
- One configured descriptor supplies identity everywhere; no independent runner string can disagree.
- Matching local P0-P3 real execution still passes; mismatched real API/Worker scope reaches explicit Task/Mission terminal escalation with a specific bounded reason, zero Agent launch and no retry loop.
- Policy revocation never starts a new operation and never prevents cleanup/observation of an already persisted binding.
- No schema drift, new dependency, registry, listener, credential, deployment or claim that remote P4 is complete.

## Pre-mortem

1. **Gate is after DAG copy.** Signal: denied Task has `inputs/**/payload`. Mitigation: materialization test asserts child path absent.
2. **Local fallback silently trusts task/API scope.** Signal: Worker starts without `RUNNER_TENANT`/allowlists. Mitigation: schema-backed startup parser fails closed; no Activity default or `CMAP_*` fallback.
3. **Initial and post-intent denial collapse together.** Signal: initial Task gets fake RUNNING, or post-intent binding is cleared/resend occurs. Mitigation: separate serialized phase variants and tests for legal transitions, tombstone retention and zero chat.

## Full-goal remaining matrix

| Area | After this slice |
|---|---|
| Local admission enforcement | Complete only after the stated real acceptance passes |
| Authenticated runner registration/heartbeat | Remaining |
| Reverse WSS + mTLS + audience-bound short tokens | Remaining |
| OIDC/multi-user Approval identity | Remaining |
| Sandbox/path/outbound policy enforcement | Remaining |
| Remote artifact storage/WORM/audit credential scans | Remaining |
| Claude Planner live 403 blocker | Remaining |
| Dedicated live YonWork profile + human controlled approval | Remaining |
| Deployment and multi-host acceptance | Remaining |

## Execution handoff

- Recommended lane: native goal execution, one `executor` owns domain + Activity gate; one `test-engineer` owns negative/real-path evidence; `verifier` independently checks zero side effects and claims. Suggested reasoning: executor high, tests medium, verifier high.
- Available relevant agent types: `explore`, `architect`, `critic`, `executor`, `test-engineer`, `verifier`, `security-auditor`, `git-master`.
- For durable full-goal continuation use `$ultragoal`; for this approved bounded slice, direct executor plus verifier is sufficient. Ralph fallback: one persistent executor follows this file stepwise and stops on failed evidence, never on a green subset.
- Architect then Critic review must be sequential. Implementation begins only after both approve or all blocking comments are incorporated.

Revision 3: Architect revision-2 findings resolved with existing transactional-event denial receipts and explicit empty-list deny-all semantics; no source implementation yet.
