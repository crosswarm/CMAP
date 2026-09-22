/* eslint-disable */
/**
 * 本文件由 schemas/mission-event.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * GET /v1/missions/:id/events 与租户级 GET /v1/events 的 SSE data。id 为 event_id 的 URI 编码，event 为 mission-event。连接先回放已提交历史，再推送新增事件；局部流的 Last-Event-ID 必须属于本 Mission，全局流的 Last-Event-ID 必须属于本租户任一 Mission。重连仍回放完整历史，以免 PostgreSQL 并发事务晚提交的低 lamport 事件被跳过；客户端按 event_id 去重，不能把 lamport 当提交游标。至少一次投递，不修改 Outbox delivered 标记。DAG_NODE_FINISHED 和 DAG_NODE_BLOCKED 只触发客户端按需重读节点状态。不公开 payload、提示词或 Agent 原始输出。无权限与不存在均为 404，未知游标为 400。 TASK_DISPATCH_INTENT records atomic durable binding and RUNNING transition before external send; it is not proof of remote acceptance.
 */
export interface MissionEventV1 {
  schema: 'cmap/mission-event/v1'
  event_id: string
  event_type: string
  event_version: number
  occurred_at: string
  mission_id: string
  task_id: string | null
  lamport: number
}
