import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryStore, type Approval, type EventActor, type Mission, type ResourceLock, type TaskEnvelopeV1, type TaskRecord } from "#domain-model";
import { createActivities } from "../../workflows/activities.ts";
import { YonWorkAdapter, type YonWorkRuntimeLike } from "../../adapters/yonwork-adapter/src/index.ts";
import { syntheticRunner } from "./fake-adapter.ts";

const ACTOR: EventActor = { type: "system", id: "yonwork-integration-test" };
const RUNNER = "runner-yonwork-test";
const PROFILE = "cmap-test";
const POLICY = "a".repeat(64);
const runner = () => syntheticRunner({
  runner_id: RUNNER,
  agents: [`yonwork:${PROFILE}`],
  admission: {
    allowed_tenants: ["tenant-test"],
    allowed_owners: ["owner-test"],
    allowed_capabilities: ["yonwork.validate"],
    max_risk: "controlled",
  },
});

const finalReply = JSON.stringify({
  status: "completed",
  summary: "ok",
  criterion_results: [{ criterion_id: "C1", actual: "true", passed: true }],
  findings: [],
  error: null,
});

const nowIso = (): string => new Date().toISOString();

const mission = (id: string): Mission => ({
  id,
  tenant: "tenant-test",
  owner: "owner-test",
  type: "inspect",
  goal: "validate through synthetic YonWork",
  constraints: {},
  acceptance: [{ criterion_id: "C1", metric: "ok", operator: "eq", expected: true, hard_gate: true }],
  workflow_template: "test/v1",
  state: "DRAFT",
  revision: 1,
  created_at: nowIso(),
  updated_at: nowIso(),
});

const envelope = (missionId: string, taskId: string): TaskEnvelopeV1 => ({
  schema: "cmap/task-envelope/v1",
  identity: {
    mission_id: missionId,
    task_id: taskId,
    idempotency_key: `${missionId}:${taskId}:1`,
    revision: 1,
    tenant: "tenant-test",
    owner: "owner-test",
  },
  classification: {
    task_type: "inspect",
    requested_capability: "yonwork.validate",
    risk_level: "controlled",
  },
  goal: {
    statement: "validate through synthetic YonWork",
    success_definition: [{ criterion_id: "C1", metric: "ok", operator: "eq", expected: true, hard_gate: true }],
  },
  inputs: { parameters: { yonwork_policy_sha256: POLICY } },
  environment: {},
  execution_policy: {
    timeout_seconds: 1,
    max_attempts: 1,
    preferred_agent: `yonwork:${PROFILE}`,
    required_resource_locks: [{ resource: "yonwork:host", ttl_seconds: 15 }],
  },
  permissions: { forbidden: [], yonwork: { chat_send: true } },
  evidence_requirements: { required_artifact_roles: ["report"] },
  output_contract: { schema_uri: "https://cmap.local/schemas/task-result/v1" },
});

class SyntheticHandle {
  readonly pid = 1;
  readonly ready = Promise.resolve();
  readonly finished = Promise.resolve({ stdout: "", stderr: "", code: 0 });
  async stop(): Promise<void> {}
}

type SendMode = "final" | "host-complete" | "unmatched" | "invalid";

class SyntheticRuntime implements YonWorkRuntimeLike {
  readonly calls: string[] = [];
  mode: SendMode = "final";
  readonly store: MemoryStore;
  readonly missionId: string;
  readonly taskId: string;

  constructor(store: MemoryStore, missionId: string, taskId: string) {
    this.store = store;
    this.missionId = missionId;
    this.taskId = taskId;
  }

  async readAgentMetadata(route: string) {
    this.calls.push(`metadata:${route}`);
    return { availability: "available" as const, agentId: PROFILE, cliVersion: "synthetic", runtimeSource: "test" };
  }

  async observeEffectivePolicy(input: { agentId: string; sessionKey: string }) {
    this.calls.push(`policy:${input.sessionKey}`);
    return { agentId: input.agentId, sessionKey: input.sessionKey, tools: [], notices: [], policySha256: POLICY };
  }

  async prepareEmptySession(input: { sessionKey: string }) {
    this.calls.push(`prepare:${input.sessionKey}`);
    await this.assertIntentPersisted("prepare");
  }

  async sendChat(input: { sessionKey: string; idempotencyKey: string; onChunk: (chunk: Buffer) => void }) {
    this.calls.push(`send:${input.sessionKey}:${input.idempotencyKey}`);
    await this.assertIntentPersisted("send");
    input.onChunk(Buffer.from(this.frame(input.sessionKey, input.idempotencyKey)));
    return new SyntheticHandle();
  }

  async watchEvents(input: { onChunk: (chunk: Buffer) => void }) {
    this.calls.push("watch");
    void input;
    return new SyntheticHandle();
  }

  async abortChat(input: { sessionKey: string; runId: string }) {
    this.calls.push(`abort:${input.sessionKey}:${input.runId}`);
  }

  private frame(sessionKey: string, runId: string): string {
    if (this.mode === "host-complete") return `event: chat.complete\ndata: ${JSON.stringify({ runId })}\n\n`;
    if (this.mode === "unmatched") {
      return `event: gateway:chat-message\ndata: ${JSON.stringify({
        message: {
          runId: "other",
          sessionKey,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: finalReply }] },
        },
      })}\n\n`;
    }
    return `event: gateway:chat-message\ndata: ${JSON.stringify({
      message: {
        runId,
        sessionKey,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: this.mode === "invalid" ? "not json" : finalReply }] },
      },
    })}\n\n`;
  }

  private async assertIntentPersisted(phase: string): Promise<void> {
    const task = await this.store.getTask(this.taskId);
    const intents = (await this.store.listEvents(this.missionId)).filter((event) => event.event_type === "TASK_DISPATCH_INTENT");
    assert.equal(task?.state, "RUNNING", `${phase} must happen after RUNNING intent`);
    assert.ok(task?.binding, `${phase} must happen after binding is persisted`);
    assert.equal(intents.length, 1, `${phase} must happen after one intent event`);
  }
}

const makeTask = async (store: MemoryStore, id: string): Promise<{ missionId: string; taskId: string }> => {
  const missionId = `mis-${id}`;
  const taskId = `tsk-${id}`;
  const created = nowIso();
  const task: TaskRecord = {
    id: taskId,
    mission_id: missionId,
    parent_task_id: null,
    supersedes_task_id: null,
    capability: "yonwork.validate",
    risk: "controlled",
    state: "DRAFT",
    attempt: 1,
    max_attempts: 1,
    lamport: 0,
    envelope: envelope(missionId, taskId),
    result: null,
    binding: null,
    deps: [],
    created_at: created,
    updated_at: created,
  };
  await store.createMission({ mission: mission(missionId), actor: ACTOR });
  await store.createTask({ task, actor: ACTOR });
  await store.transitionTask({ taskId, to: "READY", actor: ACTOR, eventType: "TASK_READY", idempotencyKey: `${taskId}:ready` });
  await approveAndLock(store, missionId, taskId);
  return { missionId, taskId };
};

const approveAndLock = async (store: MemoryStore, missionId: string, taskId: string): Promise<void> => {
  const approvalTime = nowIso();
  const approval: Approval = {
    id: `apr:${taskId}:controlled`,
    mission_id: missionId,
    task_id: taskId,
    action: "yonwork.validate",
    scope: "controlled",
    requested_by: `system:${RUNNER}`,
    risk_level: "controlled",
    reason: "synthetic integration approval for local test only",
    evidence_artifact_ids: [],
    decision: "approved",
    decided_by: "human:test-approver",
    decided_at: approvalTime,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: approvalTime,
  };
  const lock: ResourceLock = {
    lock_id: `lk-${taskId}`,
    resource: "yonwork:host",
    task_id: taskId,
    mission_id: missionId,
    holder_runner_id: RUNNER,
    acquired_at: nowIso(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    released_at: null,
  };
  await store.createApproval(approval);
  await store.acquireLock(lock);
};

const makeActivities = async (id: string, mode: SendMode = "final") => {
  const store = new MemoryStore();
  const workRoot = await mkdtemp(join(tmpdir(), "cmap-yonwork-integration-"));
  const ids = await makeTask(store, id);
  const runtime = new SyntheticRuntime(store, ids.missionId, ids.taskId);
  runtime.mode = mode;
  const adapter = new YonWorkAdapter({ profileId: PROFILE, runnerId: RUNNER, runtime });
  const acts = createActivities({ store, adapters: [adapter], runner: runner(), workRoot, pollIntervalMs: 1, waitTimeoutMs: 25 });
  return { store, workRoot, runtime, adapter, acts, ...ids };
};

test("dispatch intent is persisted before synthetic YonWork session/send and final result is control-owned evidence", async (t) => {
  const fx = await makeActivities("ok");
  t.after(() => rm(fx.workRoot, { recursive: true, force: true }));

  const dispatched = await fx.acts.dispatchTask(fx.taskId);
  const collected = await fx.acts.collectTaskResult(fx.taskId);
  assert.ok(!('executionUncertain' in collected))

  assert.equal(dispatched.dispatched, true);
  assert.equal(collected.passed, true);
  const prepareIndex = fx.runtime.calls.findIndex((call) => call.startsWith("prepare:"));
  const exactPolicyIndex = fx.runtime.calls.findIndex((call) => call.startsWith("policy:agent:cmap-test:explicit:") && !call.endsWith("cmap-policy"));
  const sendIndex = fx.runtime.calls.findIndex((call) => call.startsWith("send:"));
  assert.ok(prepareIndex >= 0 && exactPolicyIndex > prepareIndex && sendIndex > exactPolicyIndex);

  const events = await fx.store.listEvents(fx.missionId);
  assert.equal(events.filter((event) => event.event_type === "TASK_DISPATCH_INTENT").length, 1);

  const task = await fx.store.getTask(fx.taskId);
  assert.equal(task?.result?.mission_id, fx.missionId);
  assert.equal(task?.result?.task_id, fx.taskId);
  assert.equal(task?.result?.artifacts[0]?.artifact_id, `${fx.taskId}:report`);

  const reportPath = join(fx.workRoot, fx.taskId, "evidence", "yonwork-captured-report.json");
  const report = await readFile(reportPath);
  assert.equal(task?.result?.artifacts[0]?.sha256, createHash("sha256").update(report).digest("hex"));

  const [artifact] = await fx.store.listArtifacts(fx.taskId);
  assert.equal(artifact?.artifact_id, `${fx.taskId}:report`);
  assert.equal(artifact?.security.classification, "restricted");
  assert.equal(artifact?.security.contains_secrets, true);
  assert.equal(artifact?.security.contains_pii, true);
  assert.equal(artifact?.provenance["content_assessment"], "unassessed");
  assert.equal(artifact?.producer.agent_id, `yonwork:${PROFILE}`);
});

test("unmatched terminal or Host complete alone are not accepted as remote terminal proof", async (t) => {
  for (const mode of ["host-complete", "unmatched"] as const) {
    const fx = await makeActivities(mode, mode);
    t.after(() => rm(fx.workRoot, { recursive: true, force: true }));
    await fx.acts.dispatchTask(fx.taskId);
    await assert.rejects(
      fx.acts.collectTaskResult(fx.taskId),
      /等待任务 .* 终态超时/,
      mode,
    );
    assert.equal((await fx.store.getTask(fx.taskId))?.result, null);
    assert.equal((await fx.store.listArtifacts(fx.taskId)).length, 0);
  }
});

test("matched terminal with invalid strict JSON is not accepted as a result", async (t) => {
  const fx = await makeActivities("invalid", "invalid");
  t.after(() => rm(fx.workRoot, { recursive: true, force: true }));
  await fx.acts.dispatchTask(fx.taskId);

  await assert.rejects(
    fx.acts.collectTaskResult(fx.taskId),
    (error) => typeof error === "object" && error !== null && "code" in error && error.code === "YONWORK_OUTPUT_NOT_JSON",
  );
  assert.equal((await fx.store.getTask(fx.taskId))?.result, null);
  assert.equal((await fx.store.listArtifacts(fx.taskId)).length, 0);
});
