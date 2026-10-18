/* eslint-disable */
/**
 * 本文件由 schemas/mission-plan.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

export type SafeId = string

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
      node_id: SafeId
      goal: string
      capability: string
      deps: SafeId[]
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
      /**
       * YonWork permission request and immutable effective-policy pin. This is not an approval. yonwork.validate requires controlled risk, an explicit yonwork:cmap-* profile without fallback, and the yonwork:host lock.
       */
      yonwork?: {
        chat_send: true
        policy_sha256: string
      }
      /**
       * 可选：首轮派发前从 Memross 冻结该节点的记忆快照（memory_context 输入证据）。缺省时继承 Mission 的 memory 并以节点 goal 作查询；返工轮复用首轮快照，不重新检索。
       */
      memory?: {
        project_id: string
        /**
         * 省略时用节点 goal 的前 500 字。
         */
        query?: string
        limit?: number
      }
      preferred_agent?: string
      fallback_agents?: string[]
    },
    ...{
      node_id: SafeId
      goal: string
      capability: string
      deps: SafeId[]
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
      /**
       * YonWork permission request and immutable effective-policy pin. This is not an approval. yonwork.validate requires controlled risk, an explicit yonwork:cmap-* profile without fallback, and the yonwork:host lock.
       */
      yonwork?: {
        chat_send: true
        policy_sha256: string
      }
      /**
       * 可选：首轮派发前从 Memross 冻结该节点的记忆快照（memory_context 输入证据）。缺省时继承 Mission 的 memory 并以节点 goal 作查询；返工轮复用首轮快照，不重新检索。
       */
      memory?: {
        project_id: string
        /**
         * 省略时用节点 goal 的前 500 字。
         */
        query?: string
        limit?: number
      }
      preferred_agent?: string
      fallback_agents?: string[]
    }[]
  ]
}
