/* eslint-disable */
/**
 * 本文件由 schemas/mission-submission.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * POST /v1/missions 的 202 响应。accepted 表示 Workflow 已接收（或此请求此前已被接收），不代表开始执行或完成。后续读取 Mission/SSE；相同请求键永不重跑已结束的 Mission。
 */
export interface MissionSubmissionV1 {
  accepted: true
  mission_id: string
  workflow_id: string
}
