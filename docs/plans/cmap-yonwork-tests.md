# YonWork adapter acceptance matrix — draft v3

| Boundary | Evidence required |
| --- | --- |
| Schema | Valid response accepted; malformed/extra/identity/path fields rejected; generated type synchronized |
| Runtime selection | Current YonWork directory selected; Host overrides rejected without values leaking; no fallback through auth/protocol errors |
| Opt-in routing | Default C/K unchanged; absent underlying agent config unavailable; unsupported capability/policy/evidence roles do not spawn |
| Resource boundary | Missing declared yonwork:host lock refuses send; probes do not block Worker heartbeat; actual lock acquisition/renewal/release remains DAG-owned |
| Actual authority | Declared but unheld lease, wrong runner/task, expired lease, lost renewal or stale/wrong-scope Approval never sends; profile route/hash change after approval rejects |
| Profile policy | Agent-list/config.get metadata is not proof; tools.effective empty inventory/no unresolved notices on exact selected session; canonical hash matches baseline approved pin; unknown policy unavailable; no default/main profile fallback |
| Empty session bootstrap | Only sole intent claimant prepares its exact new key with no messages/routing/model/profile overrides; prove no Agent invocation before per-attempt tools.effective succeeds; failure before/after prepare never resends chat |
| Authorization | read-meta/read-sensitive/mutating chat attempts refused; controlled pending/rejected/wrong-scope never dispatch; actual approved controlled proceeds |
| Idempotence | Concurrent starts one real fake-CLI invocation; same-key changed goal conflicts; stored binding or uncertainty never resends; rework uses a new attempt/session |
| Durable intent | Shared Memory/PG CAS contract atomically binds + transitions RUNNING + records intent: one claimant, same-binding replay no-op, different binding conflict; crashes before intent/after intent-before send/after ACK-before update never duplicate effect and remain legally reviewable/cancellable |
| Framing | Split UTF-8, CRLF/multiline SSE, malformed JSON, max frame/buffer/event count, EOF and heartbeat-only streams handled without false terminal |
| Correlation | Wrong/missing run/session, early unrelated Host ACK, later proper event, forged IDs inside message text, unrelated global events cannot complete or redirect cancellation |
| Terminal | Only explicit matching Gateway final/error/aborted; Host chat.error/complete/EOF/exit never terminal; abort partial JSON not success; late events cannot rewrite terminal outcome |
| Remote cancel | Exact fixed Host abort route contains sessionKey and runId; no arbitrary path/method; abort ACK only stays unconfirmed; terminal observed within bounded grace releases, uncertainty retains leases |
| Output | Strict final JSON only; no prose salvage; caller/task identity overridden by control plane; captured reply artifact described honestly |
| DAG inputs | Hash-check actual input bytes once; exact UTF-8 and aggregate 32KiB bound; binary/remote URL/changed hash/symlink/missing input rejected before send; no local paths in provider prompt |
| Files | Fixed physical task-local report, no symlink/path escape/overwrite; same-byte retry safe; independent SHA recomputation and exact criterion coverage |
| Privacy | Fake secret/prompt/delta sentinels absent from normalized events/errors/audit; only validated response report retained; no history exported |
| Artifact handling | Captured reports classified restricted/unassessed, never false claims of verified secret/PII absence; report is not accepted as independent business-operation proof |
| Real execution | Actual configured YonWork Agent session via API/Temporal and applicable controlled authority; verify structured result, report bytes, task binding, exact run correlation and final review |
| Compatibility | npm run check; appropriate Pg contracts; legacy inspect and DAG histories replay; no natural language parsed in Workflow |

Each implementation slice first produces a meaningful failing regression. Real lifecycle tests use actual fake subprocesses, not mocks returning their own assertions. Live evidence cannot be replaced by fake CLI output, a health probe, exit code, a synthetic human approval, or expert/Jev plan approval.
