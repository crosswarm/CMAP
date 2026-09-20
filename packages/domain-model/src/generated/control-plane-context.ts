/* eslint-disable */
/**
 * 本文件由 schemas/control-plane-context.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * GET /v1/context 返回给同源 WebUI 的本机控制面上下文。authentication 固定为 local，明确不是 OIDC 身份；tenant 与 owner 只来自服务端配置。
 */
export interface ControlPlaneContextV1 {
  tenant: string
  owner: string | null
  authentication: 'local'
}
