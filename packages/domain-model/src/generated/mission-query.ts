/* eslint-disable */
/**
 * 本文件由 schemas/mission-query.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

export interface MissionQueryV1 {
  tenant: string
  /**
   * 省略表示不限；给出时返回全部非终态 Mission，加最近创建的至多 N 条终态 Mission（COMPLETED/ESCALATED/FAILED/CANCELED）。
   */
  terminal_limit?: number
}
