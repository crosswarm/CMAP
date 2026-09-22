import { mkdtemp, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { DispatchContext } from "#adapter-sdk";
import { AdapterError } from "#adapter-sdk";
import type { RemoteTaskBinding, TaskEnvelopeV1 } from "#domain-model";
import { DispatchPermitError, issueDispatchPermit, verifyDispatchPermit } from "#domain-model";
import { YonWorkAdapter, type YonWorkRuntimeLike } from "../../adapters/yonwork-adapter/src/index.ts";

const policy = "a".repeat(64);
const delay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const finalJson = JSON.stringify({
  status: "completed",
  summary: "ok",
  criterion_results: [{ criterion_id: "C1", actual: "ok", passed: true }],
  findings: [],
  error: null,
});

const envelope = (overrides: Partial<TaskEnvelopeV1> = {}): TaskEnvelopeV1 => ({
  schema: "cmap/task-envelope/v1",
  identity: {
    mission_id: "mis-yw",
    task_id: "tsk-yw",
    idempotency_key: "mis-yw:tsk-yw:1",
    revision: 1,
    tenant: "tenant-a",
    owner: "owner-a",
  },
  classification: {
    task_type: "inspect",
    requested_capability: "yonwork.validate",
    risk_level: "controlled",
  },
  goal: {
    statement: "检查 YonWork 输出",
    success_definition: [{ criterion_id: "C1", metric: "ok", operator: "eq", expected: true }],
  },
  inputs: { parameters: { yonwork_policy_sha256: policy } },
  environment: {},
  execution_policy: {
    timeout_seconds: 30,
    max_attempts: 1,
    preferred_agent: "yonwork:cmap-test",
    required_resource_locks: [{ resource: "yonwork:host", ttl_seconds: 15 }],
  },
  permissions: { forbidden: [], yonwork: { chat_send: true } },
  evidence_requirements: { required_artifact_roles: ["report"] },
  output_contract: { schema_uri: "https://cmap.local/schemas/task-result/v1" },
  ...overrides,
});

const context = (
  worktree: string,
  beforeSend?: DispatchContext["beforeSend"],
  deadlineAt = new Date(Date.now() + 30_000).toISOString(),
): DispatchContext => ({
  token: "test",
  runner_id: "runner-1",
  trace_id: "trace-1",
  correlation_id: "corr-1",
  worktree,
  deadline_at: deadlineAt,
  ...(beforeSend ? { beforeSend } : {}),
});

const permitTrust = (adapterId: string, runnerId = "runner-1") => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuer = "adapter-test-control";
  const issuedMs = 1_800_000_000_000;
  let nowMs = issuedMs;
  return {
    expire: () => { nowMs = issuedMs + 1_000; },
    issue: (e: TaskEnvelopeV1) => issueDispatchPermit({
      privateKey, issuer, runnerId, adapterId, envelope: e, nowMs: issuedMs, ttlSeconds: 1,
    }),
    verifier: (token: string, e: TaskEnvelopeV1, actualAdapterId: string, actualRunnerId: string) =>
      verifyDispatchPermit(token, {
        publicKey, issuer, runnerId: actualRunnerId, adapterId: actualAdapterId, envelope: e, nowMs,
      }),
  };
};

class FakeHandle {
  pid = 1;
  stopped = false;
  ready: Promise<void>;
  finished: Promise<{ stdout: string; stderr: string; code: number | null }>;
  private readyResolve!: () => void;
  private finishResolve!: () => void;

  constructor(opts: { readonly ready?: "resolve" | "never"; readonly stop?: "resolve" | "never" } = {}) {
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.finished = new Promise((resolve) => {
      this.finishResolve = () => resolve({ stdout: "", stderr: "", code: 0 });
    });
    if (opts.ready !== "never") queueMicrotask(this.readyResolve);
    this.stopMode = opts.stop ?? "resolve";
  }

  private readonly stopMode: "resolve" | "never";

  finish(): void {
    this.finishResolve();
  }

  stop = async (): Promise<void> => {
    this.stopped = true;
    if (this.stopMode === "never") return new Promise(() => undefined);
    this.finish();
  };
}

class FakeRuntime implements YonWorkRuntimeLike {
  calls: string[] = [];
  metadata = { availability: "available" as const, agentId: "cmap-test", cliVersion: "1.0.0", runtimeSource: "fake" };
  policySha256 = policy;
  failSend = false;
  sendChunks: string[] = [];
  watcherChunks: string[] = [];
  sends = 0;
  lastMessage = "";
  chatHandle = new FakeHandle();
  watcherHandle = new FakeHandle();

  async readAgentMetadata(route: string) {
    this.calls.push(`metadata:${route}`);
    return this.metadata;
  }

  async observeEffectivePolicy(input: { agentId: string; sessionKey: string }) {
    this.calls.push(`policy:${input.sessionKey}`);
    return {
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      tools: [],
      notices: [],
      policySha256: this.policySha256,
    };
  }

  async prepareEmptySession(input: { sessionKey: string }) {
    this.calls.push(`prepare:${input.sessionKey}`);
  }

  async sendChat(input: { sessionKey: string; message: string; idempotencyKey: string; timeoutMs: number; onChunk: (chunk: Buffer) => void }) {
    this.calls.push(`send:${input.sessionKey}:${input.idempotencyKey}:timeout=${input.timeoutMs}`);
    this.sends += 1;
    this.lastMessage = input.message;
    if (this.failSend) throw new Error("accepted maybe, lost local stream");
    for (const chunk of this.sendChunks) {
      setTimeout(() => input.onChunk(Buffer.from(chunk)), 0);
    }
    setTimeout(() => this.chatHandle.finish(), 1);
    return this.chatHandle;
  }

  async watchEvents(input: { timeoutMs: number; onChunk: (chunk: Buffer) => void }) {
    this.calls.push(`watch:timeout=${input.timeoutMs}`);
    for (const chunk of this.watcherChunks) {
      setTimeout(() => input.onChunk(Buffer.from(chunk)), 0);
    }
    return this.watcherHandle;
  }

  async abortChat(input: { sessionKey: string; runId: string }) {
    this.calls.push(`abort:${input.sessionKey}:${input.runId}`);
  }
}

class HangingRuntime extends FakeRuntime {
  mode: "watch" | "ready" | "abort" | "stop" = "watch";
  lateHandle: FakeHandle | null = null;

  override async watchEvents(input: { timeoutMs: number; onChunk: (chunk: Buffer) => void }) {
    this.calls.push(`watch:timeout=${input.timeoutMs}`);
    if (this.mode === "watch") {
      return new Promise<FakeHandle>((resolve) => {
        setTimeout(() => {
          this.lateHandle = new FakeHandle();
          resolve(this.lateHandle);
        }, 5_050);
      });
    }
    return new FakeHandle({
      ready: this.mode === "ready" ? "never" : "resolve",
      stop: this.mode === "stop" ? "never" : "resolve",
    });
  }

  override async abortChat(input: { sessionKey: string; runId: string }) {
    this.calls.push(`abort:${input.sessionKey}:${input.runId}`);
    if (this.mode === "abort") return new Promise<void>(() => undefined);
  }
}

class DelayedMetadataRuntime extends FakeRuntime {
  releaseMetadata!: () => void;
  metadataBlocked = new Promise<void>((resolve) => {
    this.releaseMetadata = resolve;
  });

  override async readAgentMetadata(route: string) {
    this.calls.push(`metadata:${route}`);
    await this.metadataBlocked;
    return this.metadata;
  }
}

class DelayedSendRuntime extends FakeRuntime {
  releaseSend!: () => void;
  delayedHandle = new FakeHandle();
  sendBlocked = new Promise<void>((resolve) => {
    this.releaseSend = resolve;
  });

  override async sendChat(input: { sessionKey: string; message: string; idempotencyKey: string; timeoutMs: number; onChunk: (chunk: Buffer) => void }) {
    this.calls.push(`send:${input.sessionKey}:${input.idempotencyKey}:timeout=${input.timeoutMs}`);
    this.sends += 1;
    await this.sendBlocked;
    return this.delayedHandle;
  }
}

const terminalChunk = (binding: RemoteTaskBinding, state: "final" | "error" | "aborted", text = finalJson): string =>
  `event: gateway:chat-message\ndata: ${JSON.stringify({
    runId: binding.remote_task_id,
    sessionKey: binding.remote_context_id,
    state,
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
  })}\n\n`;

const makeAdapter = (runtime = new FakeRuntime()): { adapter: YonWorkAdapter; runtime: FakeRuntime } => ({
  runtime,
  adapter: new YonWorkAdapter({ authorization: { mode: 'standalone' }, profileId: "cmap-test", runnerId: "runner-1", runtime }),
});

test("discovers the dedicated controlled YonWork capability", async () => {
  const { adapter } = makeAdapter();
  assert.deepEqual(await adapter.discover(), {
    adapter_id: "yonwork-adapter",
    agent_id: "yonwork:cmap-test",
    provider: "yonwork",
    version: "0.1.0",
    capabilities: ["yonwork.validate"],
    risk_ceiling: "controlled",
    supports_session_resume: false,
    supports_worktree_isolation: false,
    execution_level: "B",
  });
});

test("uses fixed baseline policy session, then sends once after exact-session guard", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { adapter, runtime } = makeAdapter();
  const e = envelope();
  const prepared = adapter.prepareBinding(e, context(dir));
  runtime.sendChunks = [terminalChunk(prepared, "final")];
  const seen: RemoteTaskBinding[] = [];
  const binding = await adapter.startTask(e, context(dir, async (b, p) => {
    seen.push(b);
    assert.equal(p, policy);
  }));
  await delay();
  const again = await adapter.startTask(e, context(dir, async () => {
    throw new Error("must not call guard twice");
  }));

  assert.deepEqual(binding, prepared);
  assert.deepEqual(again, prepared);
  assert.equal(runtime.sends, 1);
  assert.deepEqual(seen, [prepared]);
  assert.deepEqual(runtime.calls.slice(0, 4), [
    "metadata:yonwork:cmap-test",
    "policy:agent:cmap-test:explicit:cmap-policy",
    `prepare:${prepared.remote_context_id}`,
    `policy:${prepared.remote_context_id}`,
  ]);
  const timeout = Number(runtime.calls[4]!.match(/timeout=(\d+)/)![1]);
  assert.ok(timeout > 0 && timeout <= 30_000);
  assert.equal((await adapter.getStatus(binding)).status, "completed");
});

test("late terminal mutates stored shared state and later terminal is ignored", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-late-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { adapter, runtime } = makeAdapter();
  const binding = adapter.prepareBinding(envelope(), context(dir));
  runtime.sendChunks = [
    terminalChunk(binding, "final"),
    terminalChunk(binding, "error", "late error"),
  ];
  await adapter.startTask(envelope(), context(dir, async () => undefined));
  assert.equal((await adapter.getStatus(binding)).status, "running");
  await delay();
  assert.equal((await adapter.getStatus(binding)).status, "completed");
  const result = await adapter.collectResult(binding);
  assert.equal(result.summary, "ok");
});

test("same idempotency key rejects changed policy and caller mutation cannot alter stored snapshot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-alias-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { adapter, runtime } = makeAdapter();
  const e = envelope();
  const binding = adapter.prepareBinding(e, context(dir));
  runtime.sendChunks = [terminalChunk(binding, "final")];
  await adapter.startTask(e, context(dir, async () => undefined));
  e.inputs!.parameters!["yonwork_policy_sha256"] = "b".repeat(64);
  await assert.rejects(
    adapter.startTask(e, context(dir, async () => undefined)),
    (err) => err instanceof AdapterError && err.code === "YONWORK_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(runtime.sends, 1);
});

test("rejects wrong route, runner, scope, permission, policy, and missing guard before send", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-reject-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const [name, e, ctx] of [
    ["route", envelope({ execution_policy: { ...envelope().execution_policy, preferred_agent: "yonwork:cmap-other" } }), context(dir, async () => undefined)],
    ["risk", envelope({ classification: { ...envelope().classification, risk_level: "read-meta" } }), context(dir, async () => undefined)],
    ["capability", envelope({ classification: { ...envelope().classification, requested_capability: "code.analyze" } }), context(dir, async () => undefined)],
    ["permission", envelope({ permissions: { forbidden: [], yonwork: { chat_send: false } } }), context(dir, async () => undefined)],
    ["forbidden", envelope({ permissions: { forbidden: ["production_access"], yonwork: { chat_send: true } } }), context(dir, async () => undefined)],
    ["model", envelope({ execution_policy: { ...envelope().execution_policy, model_policy: { model: "x", effort: "low", source: "task_override" } } }), context(dir, async () => undefined)],
    ["fallback", envelope({ execution_policy: { ...envelope().execution_policy, fallback_agents: ["codex"] } }), context(dir, async () => undefined)],
    ["policy", envelope({ inputs: { parameters: { yonwork_policy_sha256: "bad" } } }), context(dir, async () => undefined)],
    ["runner", envelope(), context(dir, async () => undefined) satisfies DispatchContext],
    ["guard", envelope(), context(dir)],
  ] as const) {
    const { adapter, runtime } = makeAdapter();
    const actualCtx = name === "runner" ? { ...ctx, runner_id: "runner-other" } : ctx;
    await assert.rejects(
      adapter.startTask(e, actualCtx),
      (err) => err instanceof AdapterError,
      name,
    );
    assert.equal(runtime.sends, 0, name);
  }
});

test("policy drift and pre-send guard failure reject without send", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ["drift", "guard"] as const) {
    const { adapter, runtime } = makeAdapter();
    if (mode === "drift") runtime.policySha256 = "b".repeat(64);
    await assert.rejects(
      adapter.startTask(envelope(), context(dir, async () => {
        if (mode === "guard") throw new Error("lease lost");
      })),
      (err) => err instanceof AdapterError || err instanceof Error,
    );
    assert.equal(runtime.sends, 0);
  }
});

test("managed YonWork rejects malformed permit before reservation or runtime reads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-managed-first-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new FakeRuntime();
  const trust = permitTrust("yonwork-adapter");
  const adapter = new YonWorkAdapter({
    authorization: { mode: "managed", verifier: trust.verifier },
    profileId: "cmap-test",
    runnerId: "runner-1",
    runtime,
  });

  await assert.rejects(
    adapter.startTask(envelope(), { ...context(dir, async () => undefined), token: "" }),
    (err) => err instanceof DispatchPermitError && err.code === "MALFORMED",
  );
  assert.deepEqual(runtime.calls, []);
  assert.equal(runtime.sends, 0);
});

test("managed YonWork rejects a permit that expires after beforeSend and before chat send", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-managed-final-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new FakeRuntime();
  const trust = permitTrust("yonwork-adapter");
  const adapter = new YonWorkAdapter({
    authorization: { mode: "managed", verifier: trust.verifier },
    profileId: "cmap-test",
    runnerId: "runner-1",
    runtime,
  });
  const e = envelope();
  const binding = adapter.prepareBinding(e, context(dir));

  await assert.rejects(
    adapter.startTask(e, {
      ...context(dir, async () => { trust.expire(); }),
      token: trust.issue(e),
    }),
    (err) => err instanceof DispatchPermitError && err.code === "EXPIRED",
  );
  assert.equal(runtime.sends, 0);
  assert.deepEqual(runtime.calls.slice(0, 4), [
    "metadata:yonwork:cmap-test",
    "policy:agent:cmap-test:explicit:cmap-policy",
    `prepare:${binding.remote_context_id}`,
    `policy:${binding.remote_context_id}`,
  ]);
});

test("YonWork authorization mode is snapshotted at construction", () => {
  const authorization = { mode: "standalone" } as const;
  const adapter = new YonWorkAdapter({
    authorization,
    profileId: "cmap-test",
    runnerId: "runner-1",
    runtime: new FakeRuntime(),
  });
  (authorization as unknown as { mode: "managed" }).mode = "managed";
  assert.equal(adapter.authorizationMode, "standalone");
});

test("YonWork snapshots dispatch context before async startup can be redirected", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-ctx-snapshot-"));
  const other = await mkdtemp(join(tmpdir(), "cmap-yonwork-ctx-other-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => rm(other, { recursive: true, force: true }));
  const runtime = new DelayedMetadataRuntime();
  const adapter = new YonWorkAdapter({ authorization: { mode: "standalone" }, profileId: "cmap-test", runnerId: "runner-1", runtime });
  let originalCalled = false;
  let mutatedCalled = false;
  const ctx = context(dir, async () => { originalCalled = true; });
  const e = envelope();
  const starting = adapter.startTask(e, ctx);
  (ctx as { beforeSend: DispatchContext["beforeSend"]; worktree: string }).beforeSend = async () => {
    mutatedCalled = true;
    throw new Error("redirected callback");
  };
  (ctx as { worktree: string }).worktree = other;
  runtime.releaseMetadata();
  const binding = await starting;

  assert.deepEqual(binding, adapter.prepareBinding(e, context(dir)));
  assert.equal(originalCalled, true);
  assert.equal(mutatedCalled, false);
  assert.equal(runtime.sends, 1);
});

test("stream close without exact terminal stays running and collect refuses uncertainty", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-open-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { adapter, runtime } = makeAdapter();
  const binding = adapter.prepareBinding(envelope(), context(dir));
  runtime.sendChunks = ["event: chat.complete\ndata: {\"runId\":\"ignored\"}\n\n"];
  await adapter.startTask(envelope(), context(dir, async () => undefined));
  await delay();

  const status = await adapter.getStatus(binding);
  assert.equal(status.status, "running");
  assert.equal(status.terminal_observed, false);
  await assert.rejects(
    adapter.collectResult(binding),
    (err) => err instanceof AdapterError && err.code === "YONWORK_RESULT_UNAVAILABLE",
  );
});

test("cancel starts watcher before abort and waits for delayed owned terminal proof", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { adapter, runtime } = makeAdapter();
  const e = envelope();
  const binding = adapter.prepareBinding(e, context(dir));
  runtime.sendChunks = [];
  await adapter.startTask(e, context(dir, async () => undefined));
  await adapter.cancel(binding, "lease lost");
  assert.equal((await adapter.getStatus(binding)).status, "running");
  runtime.watcherChunks = [terminalChunk(binding, "aborted", "")];
  await adapter.cancel(binding, "lease lost");
  assert.equal((await adapter.getStatus(binding)).status, "canceled");
  const watchIndex = runtime.calls.findIndex((call) => call.startsWith("watch:"));
  const abortIndex = runtime.calls.findIndex((call) => call.startsWith("abort:"));
  assert.ok(watchIndex >= 0 && abortIndex > watchIndex);
});

test("tampered persisted binding is rejected, but fresh adapter can scoped-cancel exact persisted binding", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-recover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { adapter } = makeAdapter();
  const binding = adapter.prepareBinding(envelope(), context(dir));
  await assert.rejects(
    adapter.getStatus({ ...binding, remote_context_id: "agent:cmap-test:explicit:" + "b".repeat(64) }),
    (err) => err instanceof AdapterError && err.code === "YONWORK_BINDING_MISMATCH",
  );
  await assert.rejects(
    adapter.getStatus({ ...binding, remote_task_id: "cmap-" + "b".repeat(48) }),
    (err) => err instanceof AdapterError && err.code === "YONWORK_BINDING_MISMATCH",
  );

  const runtime = new FakeRuntime();
  runtime.watcherChunks = [terminalChunk(binding, "aborted", "")];
  const fresh = new YonWorkAdapter({ authorization: { mode: 'standalone' }, profileId: "cmap-test", runnerId: "runner-1", runtime });
  await fresh.cancel(binding, "recover");
  assert.equal((await fresh.getStatus(binding)).status, "canceled");
  await assert.rejects(
    fresh.collectResult(binding),
    (err) => err instanceof AdapterError && err.code === "YONWORK_RESULT_UNAVAILABLE",
  );
});

test("cancel keeps one 5s budget across hanging watch creation, ready, abort, and cleanup", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-cancel-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ["watch", "ready", "abort", "stop"] as const) {
    const runtime = new HangingRuntime();
    runtime.mode = mode;
    const adapter = new YonWorkAdapter({ authorization: { mode: 'standalone' }, profileId: "cmap-test", runnerId: "runner-1", runtime });
    const binding = adapter.prepareBinding(envelope({ identity: { ...envelope().identity, idempotency_key: `key-${mode}` } }), context(dir));
    const started = Date.now();
    const outcome = await Promise.race([
      adapter.cancel(binding, mode).then(() => "done"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_500)),
    ]);
    assert.equal(outcome, "done", mode);
    assert.ok(Date.now() - started < 5_500, mode);
    assert.equal((await adapter.getStatus(binding)).terminal_observed, false);
    if (mode === "watch") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(runtime.lateHandle?.stopped, true);
    }
  }
});

test("cancel during in-flight start does not wait for metadata or allow late send", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-cancel-start-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new DelayedMetadataRuntime();
  const adapter = new YonWorkAdapter({ authorization: { mode: 'standalone' }, profileId: "cmap-test", runnerId: "runner-1", runtime });
  const e = envelope();
  const binding = adapter.prepareBinding(e, context(dir));
  const starting = adapter.startTask(e, context(dir, async () => undefined)).catch((error: unknown) => error);
  await delay();

  const canceling = adapter.cancel(binding, "lease lost");
  await delay();
  assert.ok(runtime.calls.some((call) => call.startsWith("watch:")));
  assert.ok(runtime.calls.some((call) => call.startsWith("abort:")));
  runtime.releaseMetadata();
  await canceling;
  await starting;
  assert.equal(runtime.sends, 0);
  assert.equal((await adapter.getStatus(binding)).terminal_observed, false);
});

test("cancel before delayed send handle arrives performs late scoped abort and stop", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-cancel-send-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new DelayedSendRuntime();
  const adapter = new YonWorkAdapter({ authorization: { mode: 'standalone' }, profileId: "cmap-test", runnerId: "runner-1", runtime });
  const e = envelope();
  const binding = adapter.prepareBinding(e, context(dir));
  const starting = adapter.startTask(e, context(dir, async () => undefined));
  while (runtime.sends === 0) await delay();
  const canceling = adapter.cancel(binding, "lease lost");
  await canceling;
  const abortsBeforeHandle = runtime.calls.filter((call) => call.startsWith("abort:")).length;

  runtime.releaseSend();
  await starting;

  assert.equal(runtime.delayedHandle.stopped, true);
  assert.equal(runtime.calls.filter((call) => call.startsWith("abort:")).length, abortsBeforeHandle + 1);
  assert.equal((await adapter.getStatus(binding)).terminal_observed, false);
});

test("uncertain send failure leaves a tombstone and same key never resends", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { adapter, runtime } = makeAdapter();
  runtime.failSend = true;
  const cause = await adapter
    .startTask(envelope(), context(dir, async () => undefined))
    .then(() => null, (error: unknown) => error);
  assert.equal((cause as { code?: string } | null)?.code, "YONWORK_RUNTIME_FAILED");
  runtime.failSend = false;
  const binding = await adapter.startTask(envelope(), context(dir, async () => undefined));
  assert.equal(runtime.sends, 1);
  assert.equal(binding.remote_task_id, adapter.prepareBinding(envelope(), context(dir)).remote_task_id);
  assert.equal((await adapter.getStatus(binding)).status, "running");
});

test("subscribe reports current sanitized state and terminal updates without false active proof", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-sub-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { adapter, runtime } = makeAdapter();
  const binding = adapter.prepareBinding(envelope(), context(dir));
  runtime.sendChunks = [terminalChunk(binding, "final")];
  await adapter.startTask(envelope(), context(dir, async () => undefined));
  const events: string[] = [];
  const sub = await adapter.subscribe(binding, async (event) => {
    events.push(`${event.kind}:${event.message ?? ""}`);
  });
  await delay();
  await sub.unsubscribe();
  assert.deepEqual(events, ["progress:terminal_observed=false", "completed:terminal_observed=true"]);
});

test("deadline budget is passed to runtime instead of a fresh full timeout", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-deadline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { adapter, runtime } = makeAdapter();
  const binding = adapter.prepareBinding(envelope(), context(dir));
  runtime.sendChunks = [terminalChunk(binding, "final")];
  await adapter.startTask(envelope(), context(dir, async () => undefined, new Date(Date.now() + 50).toISOString()));
  const send = runtime.calls.find((call) => call.startsWith("send:"));
  assert.match(send ?? "", /timeout=\d+/);
  assert.ok(Number(send!.match(/timeout=(\d+)/)![1]) <= 1000);
});

test("expired or invalid deadline rejects before send", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-expired-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const deadline of [new Date(Date.now() - 1).toISOString(), "not-a-date"]) {
    const { adapter, runtime } = makeAdapter();
    await assert.rejects(
      adapter.startTask(envelope(), context(dir, async () => undefined, deadline)),
      (error) => error instanceof AdapterError && error.code === "YONWORK_DEADLINE_EXPIRED",
    );
    assert.equal(runtime.sends, 0);
  }
});
