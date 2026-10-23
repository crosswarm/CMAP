/* eslint-disable */
/**
 * 本文件由 schemas/control-plane-context.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * GET /v1/context 返回给同源 WebUI 的控制面上下文。authentication 为 local 时是本机模式：tenant 与 owner 只来自服务端配置，不是 OIDC 身份。为 oidc 时 tenant 取自 token 的 tenant claim、owner 取自 sub（映射见 docs/identity.md），请求必须带有效 Bearer JWT。
 */
export interface ControlPlaneContextV1 {
  tenant: string
  owner: string | null
  authentication: 'local' | 'oidc'
}
