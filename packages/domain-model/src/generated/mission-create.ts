/* eslint-disable */
/**
 * 本文件由 schemas/mission-create.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * 本机 POST /v1/missions 请求。request_id 为客户端重试键；控制面按 tenant/owner/request_id 派生 Mission ID。相同键和语义输入幂等，修改目标/约束返回 409。先入账本再启动 Workflow；启动失败返回 503，客户端使用原键重试恢复，不能更换键重建。只接受 JSON（最多 64KiB），跨来源浏览器写入拒绝。tenant/owner/state/id 不接受调用方自述。一律启动 dag/v1：不含 plan 时控制面合成单节点计划（节点 main，capability code.analyze，承载 goal、全部验收、risk_level 与 memory），返工预算仍为 max_additional_cycles；显式 plan 通过图、风险上限及验收覆盖校验后使用。inspect/v1 只保留给已入账的历史 Mission。此接口不生成自然语言计划。外部 Planner 复用本契约，只补充经校验的 plan，不改变调用方的目标、验收、风险上限、预算或 request_id。
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
  /**
   * 可选：续作上一个 Mission（仅限不含 plan 的请求，不能与 plan 同时出现）。来源必须同租户、同 owner 且已终结（COMPLETED/FAILED/ESCALATED/CANCELED），否则 400。新 Mission 合成节点的首轮任务收到来源已验收通过的产物（continuation_input）、来源的记忆快照（continuation_memory）与从账本推出的交接内容（handoff），作为冻结输入证据；不恢复 Agent 会话。
   */
  continues_mission_id?: string
  /**
   * 可选：派发前从 Memross 共享记忆检索并冻结上下文快照，作为首个任务的 memory_context 输入证据交付；与 plan 同时出现时作为各节点的缺省记忆（以节点 goal 作查询，节点可用自己的 memory 覆盖）。返工轮复用首轮快照，不重新检索。检索主体与授权由控制面配置的 Memross 凭据在服务端判定，调用方只能缩小范围。Memross 不可用时该 Mission 失败关闭，不静默降级。
   */
  memory?: {
    project_id: string
    /**
     * 省略时用 goal 的前 500 字。
     */
    query?: string
    limit?: number
  }
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
