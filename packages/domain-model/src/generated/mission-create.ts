/* eslint-disable */
/**
 * 本文件由 schemas/mission-create.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * 本机 POST /v1/missions 请求。request_id 为客户端重试键；控制面按 tenant/owner/request_id 派生 Mission ID。相同键和语义输入幂等，修改目标/约束返回 409。先入账本再启动 Workflow；启动失败返回 503，客户端使用原键重试恢复，不能更换键重建。只接受 JSON（最多 64KiB），跨来源浏览器写入拒绝。tenant/owner/state/id 不接受调用方自述。本阶段启动既有 inspect/v1 单任务返工流程，不宣称 DAG 规划已实现。
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
