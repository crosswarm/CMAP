/* eslint-disable */
/**
 * 本文件由 schemas/quota-handoff.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 *
 * 注意：本 Schema 含顶层 allOf(if/then) 条件必填约束，无法用 TypeScript
 * 结构类型表达。类型检查通过不代表满足契约——运行时仍须经 ajv 校验。
 */

export type Identifier = string

/**
 * QUOTA_HANDOFF 事件的 payload（ADR-0009 §3）。dag/v1 节点任务以 QUOTA_EXHAUSTED 结束时，控制面派生同一轮次的续接任务（supersedes_task_id 指向原任务），不消耗返工预算；每个节点的续接次数有上限（默认 2），超限节点升级给人且不写本事件。续接任务派发时排除 excluded_agents（原 Agent 及本链路此前触顶的 Agent）。只读级（read-meta、read-sensitive）新开工作区；有写副作用的级别（controlled、mutating）必须先有 exit_proof 证明原 Agent 已退出，再以原工作区快照作为冻结输入（snapshot），不共享可写工作区；其审批绑定新任务、重新走闸口。幂等键 quota-handoff:<from_task_id>。只存标识、枚举与哈希，不存工作区内容或 Agent 输出。
 */
export interface QuotaHandoffV1 {
  schema: 'cmap/quota-handoff/v1'
  node_id: string
  from_task_id: Identifier
  to_task_id: Identifier
  /**
   * 本节点第几次续接，从 1 起。
   */
  handoff_index: number
  from_agent: Identifier
  /**
   * @minItems 1
   */
  excluded_agents: [Identifier, ...Identifier[]]
  risk_level: 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating'
  workspace: 'fresh' | 'snapshot'
  /**
   * 原工作区快照（不含 inputs/ 与符号链接），登记为续接任务名下的 workspace_snapshot 冻结输入，并在新工作区解包。
   */
  snapshot: null | {
    artifact_id: Identifier
    sha256: string
    size_bytes: number
    file_count: number
  }
  /**
   * 原 Agent 已退出的证据：结果已落账（运行记录完结）且 Adapter 观测到终态（进程组已不在）。
   */
  exit_proof: null | {
    result_recorded: true
    terminal_observed: true
    status: 'completed' | 'failed' | 'canceled'
    observed_at: string
  }
}
