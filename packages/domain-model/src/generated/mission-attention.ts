/* eslint-disable */
/**
 * 本文件由 schemas/mission-attention.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * GET /v1/missions 每个 Mission 附带的“需要人处理”摘要：该 Mission 下处于对应 Task 状态的任务数。终态 Mission 一律全 0（终态本身已说明结局）。
 */
export interface MissionAttentionV1 {
  INPUT_REQUIRED: number
  AUTH_REQUIRED: number
  APPROVAL_REQUIRED: number
  FAILED_TERMINAL: number
}
