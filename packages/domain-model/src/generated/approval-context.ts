/* eslint-disable */
/**
 * 本文件由 schemas/approval-context.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * 控制面外 Jev 辅助输入。授权字段必须由调用方核验，不能由模型生成。只含脱敏动作摘要，不含原始命令、提示词或证据内容。
 */
export interface ApprovalContextV1 {
  surface: 'codex_tool' | 'cmap_approval'
  request_id: string
  action_summary: string
  risk: 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating'
  environment: 'local' | 'test' | 'production'
  reversible: boolean
  authorization_verified: boolean
  authorization_scope: 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating' | null
  requires_human: boolean
}
