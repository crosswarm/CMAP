# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-08-05] Preserve contract-first and test-first sequencing**
   Do instead: update schemas and generated types before behavior, then prove the intended failure before the minimal implementation.

## Domain Behavior Guardrails
1. **[2026-08-06] Make Agent assignment and handoff explicit in WebUI designs**
   Do instead: show current owner, source and target Agent, structured handoff package, acknowledgement state, and the task-scoped collaboration thread.
2. **[2026-08-06] Separate Agent defaults from Task execution overrides**
   Do instead: show provider/model/effort defaults on the Agent profile and label per-Task values as inherited or explicitly overridden.
3. **[2026-08-05] Keep approval scopes visually and behaviorally separate**
   Do instead: represent `controlled` and `mutating` as independent grants and require the submitted scope to match the pending approval.
4. **[2026-08-05] Distinguish passive waiting from user-blocking states**
   Do instead: present `WAITING_RESOURCE` as normal queueing and `APPROVAL_REQUIRED` or `INPUT_REQUIRED` as explicit human action.

## Shell & Command Reliability
1. **[2026-08-05] CodeGraph may be unavailable in a fresh CMAP checkout**
   Do instead: check index availability once, then use bounded `rg` and targeted file reads without initializing new repo state unless requested.

## User Directives
1. **[2026-08-07] Store generated CMAP design images under project docs**
   Do instead: place all design generations in `docs/design/prototype/`; do not leave deliverable copies under `.codex/generated_images` or root `design/`.
2. **[2026-08-05] Keep current user work intact**
   Do instead: inspect `git status` first, avoid unrelated files, and report exact validation evidence.
