/**
 * 假 Adapter：实现与 codex-adapter 完全相同的 SPI，但不 spawn 任何进程。
 *
 * 用途是验证**控制面这一侧**的接线——调没调、落没落库、身份字段谁说了算。
 * 真实 Agent 链路由 scripts/e2e-mission.mjs 覆盖，两者缺一不可：假 Adapter
 * 证明逻辑正确，真链路证明它接的是真东西。
 *
 * 本文件不以 .test.ts 结尾，避免被测试运行器当作独立用例执行。
 */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  issueDispatchPermit,
  verifyDispatchPermit,
  type RemoteTaskBinding,
  type RunnerDescriptor,
  type TaskEnvelopeV1,
  type TaskResultV1,
} from '#domain-model'
import type {
  AgentAdapter,
  AdapterAuthorization,
  AdapterDescriptor,
  AdapterHealth,
  DispatchContext,
  DispatchPermitSigner,
  NormalizedAgentStatus,
} from '#adapter-sdk'
import { assertAdapterAuthorization } from '#adapter-sdk'

const syntheticTrust = generateKeyPairSync('ed25519')
const syntheticIssuer = 'cmap-test-synthetic-dispatch-permit'

export const syntheticPermitSigner: DispatchPermitSigner = (envelope, audience) =>
  issueDispatchPermit({
    privateKey: syntheticTrust.privateKey,
    issuer: syntheticIssuer,
    runnerId: audience.runnerId,
    adapterId: audience.adapterId,
    envelope,
  })

export const syntheticAdapterAuthorization = (pin?: { readonly runnerId?: string }): AdapterAuthorization => ({
  mode: 'managed',
  verifier: (token, envelope, adapterId, runnerId) => verifyDispatchPermit(token, {
    publicKey: syntheticTrust.publicKey,
    issuer: syntheticIssuer,
    runnerId: pin?.runnerId ?? runnerId,
    adapterId,
    envelope,
  }),
})

export const syntheticActivityDeps = <T extends object>(
  deps: T,
): T & { readonly signDispatchPermit: DispatchPermitSigner } => ({
  ...deps,
  signDispatchPermit: syntheticPermitSigner,
})

export const syntheticRunner = (
  overrides: Partial<RunnerDescriptor> = {},
): RunnerDescriptor => ({
  runner_id: 'runner-test',
  tenant: 'team-ycc',
  host: 'test-host',
  agents: [
    'fake',
    'codex',
    'kimi',
    'right',
    'wrong',
    'unrelated',
    'primary',
    'backup',
    'low',
    'broken',
    'original',
    'replacement',
    'actual',
    'other',
    'yonwork:cmap-test',
  ],
  resources: ['device-A', 'device-C', 'yonwork:host'],
  admission: {
    allowed_tenants: ['team-ycc', 'local', 'test'],
    allowed_owners: ['crosswarm', 'test', 'test-harness'],
    allowed_capabilities: [
      'code.analyze',
      'code.modify',
      'realdevice-validation',
      'perf.optimize',
      'codex.performance.root_cause',
      'yonwork.validate',
    ],
    max_risk: 'mutating',
  },
  health: 'healthy',
  last_heartbeat_at: '2026-09-22T00:00:00.000Z',
  ...overrides,
})

export class FakeAdapter implements AgentAdapter {
  readonly adapterId = 'fake-adapter'
  readonly agentId = 'fake'
  readonly authorizationMode = 'managed'

  /** 每次 startTask 的信封，用于断言「Adapter 真的被调用了几次」。 */
  readonly startCalls: TaskEnvelopeV1[] = []
  readonly contexts: DispatchContext[] = []
  readonly cancelCalls: RemoteTaskBinding[] = []
  readonly authorization = syntheticAdapterAuthorization()

  /** getStatus 前几次返回 running，模拟真实的等待过程。 */
  runningRounds = 1
  /** 设置后覆盖默认结果，用于构造未通过 / 漏答等情形。 */
  result: TaskResultV1 | null = null
  /** 接下来几次收结果判不达标，用于驱动返工。每次收取递减。 */
  failNext = 0
  #collects = 0
  summary = '干完了'

  #polls = 0
  readonly #envelopes = new Map<string, TaskEnvelopeV1>()

  async discover(): Promise<AdapterDescriptor> {
    return {
      adapter_id: this.adapterId, agent_id: this.agentId, provider: 'fake',
      version: '0.0.1', capabilities: ['code.analyze', 'realdevice-validation', 'perf.optimize', 'codex.performance.root_cause'], risk_ceiling: 'mutating',
      supports_session_resume: false, supports_worktree_isolation: true, execution_level: 'B',
    }
  }

  prepareBinding(envelope: TaskEnvelopeV1, ctx: DispatchContext): RemoteTaskBinding {
    return {
      adapter: this.adapterId,
      remote_task_id: `fake:${envelope.identity.task_id}`,
      protocol: 'fake-exec',
      protocol_version: '0.0.1',
      runner_id: ctx.runner_id,
    }
  }

  async startTask(envelope: TaskEnvelopeV1, ctx: DispatchContext): Promise<RemoteTaskBinding> {
    assertAdapterAuthorization(this.authorization, envelope, ctx, this.adapterId)
    const binding = this.prepareBinding(envelope, ctx)
    await ctx.beforeSend!(binding)
    assertAdapterAuthorization(this.authorization, envelope, ctx, this.adapterId)
    this.startCalls.push(envelope)
    this.contexts.push(ctx)
    this.#envelopes.set(binding.remote_task_id, envelope)
    return binding
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

  async cancel(binding: RemoteTaskBinding): Promise<void> {
    this.cancelCalls.push(binding)
  }

  /**
   * 默认逐条回应信封声明的验收标准（全部通过），并刻意把 mission_id /
   * task_id 写成 Agent 自编的值——控制面必须覆盖它们。
   */
  async collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1> {
    if (this.result) return this.result
    const envelope = this.#envelopes.get(binding.remote_task_id)
    this.#collects += 1
    const passed = this.failNext <= 0
    if (!passed) this.failNext -= 1
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
        actual: passed ? c.expected : '差得远',
        passed,
        evidence_artifact_ids: [artifactId],
      })),
      artifacts: [
        {
          artifact_id: artifactId, role: 'report',
          uri: 'evidence/report.json', media_type: 'application/json',
          size_bytes: 42,
          // 每轮证据内容不同：内容逐字节相同会被无进展检测判定为「什么都没动」
          sha256: `${this.#collects}`.padStart(64, 'a'),
        },
      ],
    }
  }

  async health(): Promise<AdapterHealth> {
    return { state: 'healthy', checked_at: new Date().toISOString() }
  }
}

/** Synthetic transport with actual report bytes for input-copy integration tests. */
export class FileFakeAdapter extends FakeAdapter {
  override async collectResult(binding: RemoteTaskBinding): Promise<TaskResultV1> {
    const result = await super.collectResult(binding)
    if (result.artifacts.length === 0) return result
    if (result.artifacts.length !== 1 || result.artifacts[0]!.uri !== 'evidence/report.json') {
      throw new Error('File fixture requires its synthetic report artifact')
    }
    const index = this.startCalls.findIndex(envelope => 'fake:' + envelope.identity.task_id === binding.remote_task_id)
    const worktree = this.contexts[index]?.worktree
    if (!worktree) throw new Error('File fixture requires a scoped worktree')
    const bytes = Buffer.from(JSON.stringify({synthetic: true, revision: result.artifacts[0]!.sha256, criteria: result.criterion_results}))
    await mkdir(join(worktree, 'evidence'), {recursive: true})
    await writeFile(join(worktree, 'evidence/report.json'), bytes)
    return {...result, artifacts: [{...result.artifacts[0]!,sha256:createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length}]}
  }
}
