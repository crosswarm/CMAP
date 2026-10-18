/* eslint-disable */
/**
 * 本文件由 schemas/mission-cancel.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * 本机 POST /v1/missions/:id/cancel 请求体。只有本机 owner 可取消自己的 Mission；终态 Mission 返回 409。控制面先记 MISSION_CANCEL_REQUESTED（含原因）再向 Workflow 发送 cancelMission 信号：未绑定的任务直接取消，已绑定的调用其 Adapter 的 cancel，确认后落 CANCELED；未能确认停止的已绑定任务保持原状态并记事件，不伪造取消。DRAFT（Workflow 未启动）直接落 CANCELED。响应复用 mission-submission v1。
 */
export interface MissionCancelV1 {
  /**
   * 取消原因，原样记入事件；不得包含凭据。
   */
  reason: string
}
