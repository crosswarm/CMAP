import { createHash } from "node:crypto";

import type {
  AgentAdapter,
  AgentInput,
  AdapterDescriptor,
  AdapterHealth,
  DispatchContext,
  NormalizedAgentEvent,
  NormalizedAgentStatus,
  SubscriptionHandle,
} from "#adapter-sdk";
import { AdapterError } from "#adapter-sdk";
import type { RemoteTaskBinding, TaskEnvelopeV1, TaskResultV1 } from "#domain-model";
import { yonWorkProfileFromRoute } from "#domain-model";
import { buildYonWorkPrompt, captureYonWorkOutput } from "./output.ts";
import { YonWorkSseReducer } from "./protocol.ts";
import { YonWorkRuntime, type YonWorkProcessHandle } from "./runtime.ts";

const ADAPTER_ID = "yonwork-adapter";
const VERSION = "0.1.0";
const POLICY_RE = /^[a-f0-9]{64}$/;
const CANCEL_TIMEOUT_MS = 5_000;
const RUN_RE = /^cmap-[a-f0-9]{48}$/;

export type YonWorkRuntimeLike = Pick<YonWorkRuntime,
  "readAgentMetadata" | "observeEffectivePolicy" | "prepareEmptySession" |
  "sendChat" | "watchEvents" | "abortChat"
>;

export interface YonWorkAdapterOptions {
  readonly profileId: string;
  readonly runnerId: string;
  readonly runtime?: YonWorkRuntimeLike;
}

type Terminal = "final" | "error" | "aborted";

interface RunState {
  readonly envelope?: TaskEnvelopeV1;
  readonly envelopeDigest?: string;
  readonly binding: RemoteTaskBinding;
  readonly reservationKey: string;
  readonly worktree?: string;
  readonly reducer: YonWorkSseReducer;
  process?: YonWorkProcessHandle;
  terminal?: Terminal;
  finalText?: string;
  error?: AdapterError;
  cancelRequested?: boolean;
  subscribers: Set<(event: NormalizedAgentEvent) => Promise<void>>;
}

const err = (code: string, message: string, retryable = false): AdapterError =>
  new AdapterError(code, message, retryable, code.toLowerCase());

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const cloneEnvelope = (envelope: TaskEnvelopeV1): TaskEnvelopeV1 =>
  JSON.parse(JSON.stringify(envelope)) as TaskEnvelopeV1;

const reservationKey = (envelope: TaskEnvelopeV1): string =>
  `${envelope.identity.tenant ?? ""}:${envelope.identity.owner ?? ""}:${envelope.identity.idempotency_key}`;

const policyPin = (envelope: TaskEnvelopeV1): string | null => {
  const value = envelope.inputs?.parameters?.["yonwork_policy_sha256"];
  return typeof value === "string" && POLICY_RE.test(value) ? value : null;
};

const assertSupported = (
  envelope: TaskEnvelopeV1,
  profileRoute: string,
  runnerId: string,
  ctx: DispatchContext,
  phase: "prepare" | "start" = "start",
): void => {
  if (ctx.runner_id !== runnerId) throw err("YONWORK_RUNNER_MISMATCH", "YonWork runner mismatch");
  if (phase === "start") {
    if (!ctx.worktree) throw err("YONWORK_WORKTREE_REQUIRED", "YonWork requires a task worktree");
    if (!ctx.beforeSend) throw err("YONWORK_BEFORE_SEND_REQUIRED", "YonWork requires control-plane beforeSend guard");
  }
  if (envelope.classification.requested_capability !== "yonwork.validate") {
    throw err("YONWORK_CAPABILITY_UNSUPPORTED", "YonWork only supports yonwork.validate");
  }
  if (envelope.classification.risk_level !== "controlled") {
    throw err("YONWORK_RISK_UNSUPPORTED", "YonWork chat dispatch requires controlled risk");
  }
  if (envelope.execution_policy.preferred_agent !== profileRoute || envelope.execution_policy.fallback_agents?.length) {
    throw err("YONWORK_ROUTE_MISMATCH", "YonWork requires exact explicit profile route without fallback");
  }
  if (envelope.permissions.yonwork?.chat_send !== true) {
    throw err("YONWORK_CHAT_SEND_REQUIRED", "YonWork requires explicit chat_send permission");
  }
  if (envelope.permissions.forbidden.length || envelope.permissions.yonwork.launch_app || envelope.permissions.yonwork.clear_test_data ||
    envelope.permissions.yonwork.query_monitor || envelope.permissions.yonwork.capture_trace || envelope.permissions.yonwork.gateway_control) {
    throw err("YONWORK_PERMISSION_UNSUPPORTED", "YonWork validate only supports report-only chat_send");
  }
  if (envelope.execution_policy.model_policy || envelope.inputs?.context) {
    throw err("YONWORK_INPUT_UNSUPPORTED", "YonWork does not support model policy or code context");
  }
  if (!envelope.execution_policy.required_resource_locks?.some((lock) => lock.resource === "yonwork:host")) {
    throw err("YONWORK_HOST_LOCK_REQUIRED", "YonWork requires declared yonwork:host lock");
  }
  if (!policyPin(envelope)) {
    throw err("YONWORK_POLICY_REQUIRED", "YonWork requires a frozen 64-hex policy hash");
  }
  if (envelope.evidence_requirements.required_artifact_roles.some((role) => role !== "report")) {
    throw err("YONWORK_EVIDENCE_UNSUPPORTED", "YonWork captured output only supports report evidence");
  }
};

export class YonWorkAdapter implements AgentAdapter {
  readonly adapterId = ADAPTER_ID;
  readonly agentId: string;
  readonly #profileId: string;
  readonly #runnerId: string;
  readonly #runtime: YonWorkRuntimeLike;
  readonly #runs = new Map<string, RunState>();
  readonly #reservations = new Map<string, RunState | Promise<RunState>>();

  constructor(opts: YonWorkAdapterOptions) {
    const route = `yonwork:${opts.profileId}`;
    const profileId = yonWorkProfileFromRoute(route);
    if (!profileId) throw err("YONWORK_PROFILE_INVALID", "YonWork profile must be cmap-*");
    this.#profileId = profileId;
    this.#runnerId = opts.runnerId;
    this.agentId = route;
    this.#runtime = opts.runtime ?? new YonWorkRuntime();
  }

  async discover(): Promise<AdapterDescriptor> {
    return {
      adapter_id: this.adapterId,
      agent_id: this.agentId,
      provider: "yonwork",
      version: VERSION,
      capabilities: ["yonwork.validate"],
      risk_ceiling: "controlled",
      supports_session_resume: false,
      supports_worktree_isolation: false,
      execution_level: "B",
    };
  }

  prepareBinding(envelope: TaskEnvelopeV1, ctx: DispatchContext): RemoteTaskBinding {
    assertSupported(envelope, this.agentId, this.#runnerId, ctx, "prepare");
    const runDigest = digest({
      adapter: ADAPTER_ID,
      runnerId: this.#runnerId,
      profileId: this.#profileId,
      identity: envelope.identity,
      capability: envelope.classification.requested_capability,
      risk: envelope.classification.risk_level,
      policy: policyPin(envelope),
    });
    const runId = `cmap-${runDigest.slice(0, 48)}`;
    return {
      adapter: ADAPTER_ID,
      remote_task_id: runId,
      remote_context_id: `agent:${this.#profileId}:explicit:${runDigest}`,
      protocol: "yonwork-host-sse",
      protocol_version: "1",
      runner_id: ctx.runner_id,
      provider_session_id: `agent:${this.#profileId}:explicit:${runDigest}`,
    };
  }

  async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    assertSupported(envelope, this.agentId, this.#runnerId, ctx);
    const key = reservationKey(envelope);
    const frozen = cloneEnvelope(envelope);
    const frozenDigest = digest(frozen);
    const reserved = this.#reservations.get(key);
    if (reserved) {
      const run = await reserved;
      if (run.envelopeDigest !== frozenDigest) {
        throw err("YONWORK_IDEMPOTENCY_CONFLICT", "YonWork idempotency key already reserved for different input");
      }
      return run.binding;
    }
    const binding = this.prepareBinding(envelope, ctx);
    const existing = this.#runs.get(binding.remote_task_id);
    if (existing) {
      if (existing.envelopeDigest !== frozenDigest) {
        throw err("YONWORK_BINDING_CONFLICT", "YonWork immutable input conflicts with existing run");
      }
      return existing.binding;
    }

    const run: RunState = {
      envelope: frozen,
      envelopeDigest: frozenDigest,
      binding,
      reservationKey: key,
      worktree: ctx.worktree!,
      reducer: new YonWorkSseReducer({
        expectedRunId: binding.remote_task_id,
        expectedSessionKey: binding.remote_context_id!,
      }),
      subscribers: new Set(),
    };
    const starting = this.#start(run, ctx).then(() => run);
    starting.catch(() => undefined);
    this.#reservations.set(key, starting);
    this.#runs.set(binding.remote_task_id, run);
    try {
      const started = await starting;
      this.#reservations.set(key, started);
      if (started.error && !started.process) throw started.error;
      return started.binding;
    } catch (cause) {
      if (run.process || run.error) {
        this.#reservations.set(key, run);
      } else {
        this.#runs.delete(binding.remote_task_id);
        this.#reservations.delete(key);
      }
      throw cause;
    }
  }

  async #start(run: RunState, ctx: DispatchContext): Promise<void> {
    const envelope = run.envelope!;
    const binding = run.binding;
    const expectedPolicy = policyPin(envelope);
    if (!expectedPolicy || !binding.remote_context_id) {
      throw err("YONWORK_BINDING_INVALID", "YonWork binding is incomplete");
    }
    const metadata = await this.#runtime.readAgentMetadata(this.agentId);
    if (run.cancelRequested) {
      run.error = err("YONWORK_CANCELED_BEFORE_SEND", "YonWork start was canceled before send", true);
      return;
    }
    if (metadata.availability !== "available" || metadata.agentId !== this.#profileId) {
      throw err("YONWORK_AGENT_UNAVAILABLE", "Configured YonWork profile is unavailable", true);
    }
    const baseline = await this.#runtime.observeEffectivePolicy({
      agentId: this.#profileId,
      sessionKey: this.#baselineSessionKey(),
    });
    if (baseline.policySha256 !== expectedPolicy) {
      throw err("YONWORK_POLICY_MISMATCH", "YonWork effective policy does not match frozen input", true);
    }
    if (run.cancelRequested) {
      run.error = err("YONWORK_CANCELED_BEFORE_SEND", "YonWork start was canceled before send", true);
      return;
    }
    const message = await buildYonWorkPrompt(envelope, ctx.worktree!);
    if (run.cancelRequested) {
      run.error = err("YONWORK_CANCELED_BEFORE_SEND", "YonWork start was canceled before send", true);
      return;
    }
    await this.#runtime.prepareEmptySession({ sessionKey: binding.remote_context_id });
    const current = await this.#runtime.observeEffectivePolicy({
      agentId: this.#profileId,
      sessionKey: binding.remote_context_id,
    });
    if (current.policySha256 !== expectedPolicy) {
      throw err("YONWORK_POLICY_MISMATCH", "YonWork exact-session policy does not match frozen input", true);
    }
    if (run.cancelRequested) {
      run.error = err("YONWORK_CANCELED_BEFORE_SEND", "YonWork start was canceled before send", true);
      return;
    }
    await ctx.beforeSend!(binding, current.policySha256);
    if (run.cancelRequested) {
      run.error = err("YONWORK_CANCELED_BEFORE_SEND", "YonWork start was canceled before send", true);
      return;
    }

    const onChunk = (chunk: Buffer): void => {
      try {
        this.#acceptChunk(run, chunk);
      } catch (cause) {
        run.error = this.#normalizeError(cause);
      }
    };
    try {
      run.process = await this.#runtime.sendChat({
        sessionKey: binding.remote_context_id,
        message,
        idempotencyKey: binding.remote_task_id,
        timeoutMs: this.#remainingMs(ctx.deadline_at),
        onChunk,
      });
    } catch (cause) {
      run.error = this.#normalizeError(cause);
      return;
    }
    if (run.cancelRequested) {
      await this.#abortAndStopOwnedRun(run, Date.now());
      return;
    }
    run.process.finished.catch((cause) => {
      if (!run.terminal) run.error = this.#normalizeError(cause);
    });
  }

  async sendInput(_binding: RemoteTaskBinding, _input: AgentInput): Promise<void> {
    throw err("YONWORK_SEND_INPUT_UNSUPPORTED", "YonWork adapter does not support sendInput");
  }

  async getStatus(binding: RemoteTaskBinding): Promise<NormalizedAgentStatus> {
    const run = await this.#require(binding, { recover: true });
    const at = new Date().toISOString();
    if (run.terminal === "final") return { status: "completed", at, terminal_observed: true };
    if (run.terminal === "error") return { status: "failed", at, terminal_observed: true };
    if (run.terminal === "aborted") return { status: "canceled", at, terminal_observed: true };
    if (run.error) return { status: "running", at, terminal_observed: false, detail: run.error.code };
    return { status: "running", at, terminal_observed: false, detail: "YonWork terminal event not observed" };
  }

  async subscribe(
    binding: RemoteTaskBinding,
    onEvent: (event: NormalizedAgentEvent) => Promise<void>,
  ): Promise<SubscriptionHandle> {
    const run = await this.#require(binding, { recover: true });
    await onEvent(this.#eventForStatus(await this.getStatus(binding)));
    run.subscribers.add(onEvent);
    return { unsubscribe: async () => {
      run.subscribers.delete(onEvent);
    } };
  }

  async cancel(binding: RemoteTaskBinding, _reason: string): Promise<void> {
    const startedAt = Date.now();
    const run = await this.#require(binding, { recover: true });
    run.cancelRequested = true;
    if (!binding.remote_context_id) throw err("YONWORK_BINDING_INVALID", "YonWork binding missing session");
    const reducer = new YonWorkSseReducer({
      expectedRunId: binding.remote_task_id,
      expectedSessionKey: binding.remote_context_id,
    });
    const watcherPromise = this.#runtime.watchEvents({
      timeoutMs: this.#cancelRemainingMs(startedAt),
      onChunk: (chunk) => {
        try {
          for (const event of reducer.push(chunk)) {
            if (event.kind === "terminal" && !run.terminal) {
              run.terminal = event.state;
              this.#emit(run, this.#eventForStatus({
                status: this.#statusForTerminal(event.state),
                at: new Date().toISOString(),
                terminal_observed: true,
              }));
            }
          }
        } catch (cause) {
          run.error = this.#normalizeError(cause);
        }
      },
    });
    const watcher = await this.#withinCancelBudget(startedAt, watcherPromise);
    if (!watcher) {
      void watcherPromise.then((late) => late.stop()).catch(() => undefined);
      return;
    }
    try {
      const ready = await this.#withinCancelBudget(startedAt, watcher.ready.then(() => true));
      if (ready) {
        await this.#withinCancelBudget(startedAt, this.#runtime.abortChat({
          sessionKey: binding.remote_context_id,
          runId: binding.remote_task_id,
        }));
        await this.#waitForTerminal(run, startedAt);
      }
    } finally {
      await this.#withinCancelBudget(startedAt, watcher.stop());
      if (run.process) await this.#withinCancelBudget(startedAt, run.process.stop());
    }
  }

  async collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1> {
    const run = await this.#require(binding);
    if (run.terminal !== "final" || !run.finalText || !run.envelope || !run.worktree) {
      throw err("YONWORK_RESULT_UNAVAILABLE", "YonWork final terminal output is unavailable", true);
    }
    return captureYonWorkOutput(run.finalText, run.envelope, run.worktree, binding.remote_context_id);
  }

  async health(): Promise<AdapterHealth> {
    try {
      const metadata = await this.#runtime.readAgentMetadata(this.agentId);
      if (metadata.availability === "available" && metadata.agentId === this.#profileId) {
        await this.#runtime.observeEffectivePolicy({
          agentId: this.#profileId,
          sessionKey: this.#baselineSessionKey(),
        });
      }
      return {
        state: metadata.availability === "available" ? "healthy" : "unavailable",
        checked_at: new Date().toISOString(),
        detail: metadata.runtimeSource,
      };
    } catch (cause) {
      const error = this.#normalizeError(cause);
      return { state: error.retryable ? "degraded" : "unavailable", checked_at: new Date().toISOString(), detail: error.code };
    }
  }

  async #require(binding: RemoteTaskBinding, opts: { readonly recover?: boolean } = {}): Promise<RunState> {
    this.#validateBinding(binding);
    const existing = this.#runs.get(binding.remote_task_id);
    if (existing) {
      if (canonicalJson(existing.binding) !== canonicalJson(binding)) {
        throw err("YONWORK_BINDING_MISMATCH", "YonWork binding does not match stored run");
      }
      return existing;
    }
    if (!opts.recover) throw err("YONWORK_BINDING_NOT_FOUND", "YonWork binding is not active");
    const run: RunState = {
      binding,
      reservationKey: `recovered:${binding.remote_task_id}`,
      reducer: new YonWorkSseReducer({
        expectedRunId: binding.remote_task_id,
        expectedSessionKey: binding.remote_context_id!,
      }),
      subscribers: new Set(),
    };
    this.#runs.set(binding.remote_task_id, run);
    return run;
  }

  #validateBinding(binding: RemoteTaskBinding): void {
    const sessionRe = new RegExp(`^agent:${this.#profileId}:explicit:[a-f0-9]{64}$`);
    const sessionDigest = binding.remote_context_id?.slice(`agent:${this.#profileId}:explicit:`.length);
    if (
      binding.adapter !== ADAPTER_ID ||
      binding.runner_id !== this.#runnerId ||
      binding.protocol !== "yonwork-host-sse" ||
      binding.protocol_version !== "1" ||
      !RUN_RE.test(binding.remote_task_id) ||
      !binding.remote_context_id ||
      !sessionRe.test(binding.remote_context_id) ||
      binding.remote_task_id !== `cmap-${sessionDigest?.slice(0, 48)}` ||
      (binding.provider_session_id !== undefined && binding.provider_session_id !== binding.remote_context_id)
    ) {
      throw err("YONWORK_BINDING_MISMATCH", "YonWork binding does not belong to this runner");
    }
  }

  #acceptChunk(run: RunState, chunk: Buffer): void {
    for (const event of run.reducer.push(chunk)) {
      if (event.kind === "terminal" && !run.terminal) {
        run.terminal = event.state;
        const finalText = run.reducer.result.finalText;
        if (finalText !== undefined) run.finalText = finalText;
        this.#emit(run, this.#eventForStatus({
          status: this.#statusForTerminal(event.state),
          at: new Date().toISOString(),
          terminal_observed: true,
        }));
      }
    }
  }

  #statusForTerminal(terminal: Terminal): NormalizedAgentStatus["status"] {
    if (terminal === "final") return "completed";
    if (terminal === "error") return "failed";
    return "canceled";
  }

  #eventForStatus(status: NormalizedAgentStatus): NormalizedAgentEvent {
    return {
      kind: status.terminal_observed
        ? status.status === "completed" ? "completed" : status.status === "canceled" ? "failed" : "failed"
        : "progress",
      at: status.at,
      message: `terminal_observed=${status.terminal_observed}`,
    };
  }

  #emit(run: RunState, event: NormalizedAgentEvent): void {
    for (const subscriber of run.subscribers) {
      void subscriber(event).catch(() => undefined);
    }
  }

  async #waitForTerminal(run: RunState, startedAt: number): Promise<void> {
    while (!run.terminal && Date.now() - startedAt < CANCEL_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async #abortAndStopOwnedRun(run: RunState, startedAt: number): Promise<void> {
    if (run.binding.remote_context_id) {
      await this.#withinCancelBudget(startedAt, this.#runtime.abortChat({
        sessionKey: run.binding.remote_context_id,
        runId: run.binding.remote_task_id,
      }));
    }
    if (run.process) await this.#withinCancelBudget(startedAt, run.process.stop());
  }

  #cancelRemainingMs(startedAt: number): number {
    return Math.max(1, CANCEL_TIMEOUT_MS - (Date.now() - startedAt));
  }

  async #withinCancelBudget<T>(startedAt: number, promise: Promise<T>): Promise<T | undefined> {
    const remaining = CANCEL_TIMEOUT_MS - (Date.now() - startedAt);
    promise.catch(() => undefined);
    if (remaining <= 0) return undefined;
    return Promise.race([
      promise.catch((cause) => {
        throw this.#normalizeError(cause);
      }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), remaining)),
    ]);
  }

  #remainingMs(deadlineAt: string): number {
    const parsed = Date.parse(deadlineAt);
    if (!Number.isFinite(parsed) || parsed <= Date.now()) {
      throw err("YONWORK_DEADLINE_EXPIRED", "YonWork deadline expired before send", true);
    }
    return parsed - Date.now();
  }

  #baselineSessionKey(): string {
    return `agent:${this.#profileId}:explicit:cmap-policy`;
  }

  #normalizeError(cause: unknown): AdapterError {
    if (cause instanceof AdapterError) return cause;
    const code = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "YONWORK_RUNTIME_FAILED";
    const retryable = typeof cause === "object" && cause !== null && "retryable" in cause && cause.retryable === true;
    return err(code, "YonWork runtime observation failed", retryable);
  }
}
