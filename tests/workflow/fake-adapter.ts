/**
 * 假 Adapter：实现与 codex-adapter 完全相同的 SPI，但不 spawn 任何进程。
 *
 * 用途是验证**控制面这一侧**的接线——调没调、落没落库、身份字段谁说了算。
 * 真实 Agent 链路由 scripts/e2e-mission.mjs 覆盖，两者缺一不可：假 Adapter
 * 证明逻辑正确，真链路证明它接的是真东西。
 *
 * 本文件不以 .test.ts 结尾，避免被测试运行器当作独立用例执行。
 */
import type { TaskEnvelopeV1, TaskResultV1, RemoteTaskBinding } from '#domain-model'
import type {
  AgentAdapter,
  AdapterDescriptor,
  AdapterHealth,
  DispatchContext,
  NormalizedAgentStatus,
} from '#adapter-sdk'

export class FakeAdapter implements AgentAdapter {
  readonly adapterId = 'fake-adapter'
  readonly agentId = 'fake'

  /** 每次 startTask 的信封，用于断言「Adapter 真的被调用了几次」。 */
  readonly startCalls: TaskEnvelopeV1[] = []
  readonly contexts: DispatchContext[] = []

  /** getStatus 前几次返回 running，模拟真实的等待过程。 */
  runningRounds = 1
  /** 设置后覆盖默认结果，用于构造未通过 / 漏答等情形。 */
  result: TaskResultV1 | null = null
  summary = '干完了'

  #polls = 0
  readonly #envelopes = new Map<string, TaskEnvelopeV1>()

  async discover(): Promise<AdapterDescriptor> {
    return {
      adapter_id: this.adapterId, agent_id: this.agentId, provider: 'fake',
      version: '0.0.1', capabilities: ['code.analyze'], risk_ceiling: 'read-meta',
      supports_session_resume: false, supports_worktree_isolation: true, execution_level: 'B',
    }
  }

  async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    this.startCalls.push(envelope)
    this.contexts.push(ctx)
    const remoteTaskId = `fake:${envelope.identity.task_id}`
    this.#envelopes.set(remoteTaskId, envelope)
    return {
      adapter: this.adapterId,
      remote_task_id: remoteTaskId,
      protocol: 'fake-exec',
      protocol_version: '0.0.1',
      runner_id: ctx.runner_id,
    }
  }

  async sendInput(): Promise<void> {}

  async getStatus(): Promise<NormalizedAgentStatus> {
    const at = new Date().toISOString()
    if (this.#polls++ < this.runningRounds) {
      return { status: 'running', at, terminal_observed: false }
    }
    return { status: 'completed', at, terminal_observed: true }
  }

  async subscribe() {
    return { unsubscribe: async () => {} }
  }

  async cancel(): Promise<void> {}

  /**
   * 默认逐条回应信封声明的验收标准（全部通过），并刻意把 mission_id /
   * task_id 写成 Agent 自编的值——控制面必须覆盖它们。
   */
  async collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1> {
    if (this.result) return this.result
    const envelope = this.#envelopes.get(binding.remote_task_id)
    // 真实 Agent 爱用 `report` 这种大众名字，这里照抄这个习惯——
    // 控制面必须自己给证据重新命名，否则第二个任务就跟第一个撞主键。
    const artifactId = 'report'
    return {
      schema: 'cmap/task-result/v1',
      mission_id: 'agent-自称的-mission',
      task_id: 'agent-自称的-task',
      attempt: 99,
      status: 'completed',
      summary: this.summary,
      criterion_results: (envelope?.goal.success_definition ?? []).map((c) => ({
        criterion_id: c.criterion_id,
        actual: c.expected,
        passed: true,
        evidence_artifact_ids: [artifactId],
      })),
      artifacts: [
        {
          artifact_id: artifactId, role: 'report',
          uri: 'evidence/report.json', media_type: 'application/json',
          size_bytes: 42, sha256: 'a'.repeat(64),
        },
      ],
    }
  }

  async health(): Promise<AdapterHealth> {
    return { state: 'healthy', checked_at: new Date().toISOString() }
  }
}
