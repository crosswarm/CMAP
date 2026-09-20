/* eslint-disable */
/**
 * 本文件由 schemas/mission-create.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * 本机 POST /v1/missions 请求。request_id 为客户端重试键；控制面按 tenant/owner/request_id 派生 Mission ID。相同键和语义输入幂等，修改目标/约束返回 409。先入账本再启动 Workflow；启动失败返回 503，客户端使用原键重试恢复，不能更换键重建。只接受 JSON（最多 64KiB），跨来源浏览器写入拒绝。tenant/owner/state/id 不接受调用方自述。不含 plan 时启动 inspect/v1 单任务返工流程；显式 plan 通过图、风险上限及验收覆盖校验后启动 dag/v1。此接口不生成自然语言计划。外部 Planner 复用本契约，只补充经校验的 plan，不改变调用方的目标、验收、风险上限、预算或 request_id。
 */
export interface MissionCreateV1 {
  request_id: string
  goal: string
  /**
   * criterion_id 必须互异；复用派发契约的验收标准定义。
   *
   * @minItems 1
   * @maxItems 50
   */
  acceptance: [Items, ...Items[]]
  risk_level: 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating'
  max_additional_cycles?: number
  plan?: MissionPlanV1
}
export interface Items {
  criterion_id: string
  metric: string
  operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq' | 'contains' | 'not_contains'
  expected: unknown
  unit?: string
  /**
   * true 表示由确定性程序判定。软判断不得覆盖硬指标。
   */
  hard_gate?: boolean
}
/**
 * DAG Mission 的显式执行计划。只描述逻辑节点、依赖、验收覆盖、风险上限内的节点风险和声明式资源锁；不接受 owner/tenant/binding/approval 等控制面事实。资源锁 TTL 限定为 15..3600 秒，给续租与取消留出余量，同时避免 runner 崩溃后长期占用资源。
 */
export interface MissionPlanV1 {
  schema: 'cmap/mission-plan/v1'
  concurrency?: number
  /**
   * @minItems 1
   * @maxItems 32
   */
  nodes: [
    {
      node_id: string
      goal: string
      capability: string
      deps: string[]
      /**
       * @minItems 1
       */
      criterion_ids: [string, ...string[]]
      /**
       * 与 yonwork-cli-adapter 既有风险模型对齐。controlled 与 mutating 的授权互不蕴含，不得合并为单一批准。
       */
      risk_level: 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating'
      required_resource_locks?: {
        resource: string
        ttl_seconds: number
      }[]
      preferred_agent?: string
      fallback_agents?: string[]
    },
    ...{
      node_id: string
      goal: string
      capability: string
      deps: string[]
      /**
       * @minItems 1
       */
      criterion_ids: [string, ...string[]]
      /**
       * 与 yonwork-cli-adapter 既有风险模型对齐。controlled 与 mutating 的授权互不蕴含，不得合并为单一批准。
       */
      risk_level: 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating'
      required_resource_locks?: {
        resource: string
        ttl_seconds: number
      }[]
      preferred_agent?: string
      fallback_agents?: string[]
    }[]
  ]
}
