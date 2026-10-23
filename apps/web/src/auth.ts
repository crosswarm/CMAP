/**
 * OIDC Authorization Code + PKCE（ADR-0008 §2），无第三方依赖。
 *
 * 构建时配置 VITE_CMAP_OIDC_ISSUER 与 VITE_CMAP_OIDC_CLIENT_ID 才启用；
 * 未配置即本机模式，不带 token。access token 只放 sessionStorage（关标签即失效），
 * 不用 refresh token：过期或 401 时整页重走登录（IdP 会话还在时无感）。
 * import.meta.env 用可选链：tests/tooling 直接在 Node 里导入 api.ts，那里没有 Vite 注入。
 */
const issuer: string | undefined = import.meta.env?.VITE_CMAP_OIDC_ISSUER
const clientId: string | undefined = import.meta.env?.VITE_CMAP_OIDC_CLIENT_ID
export const oidcEnabled = Boolean(issuer && clientId)

const TOKEN_KEY = 'cmap.oidc.token'
const PKCE_KEY = 'cmap.oidc.pkce'

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const random = (size: number) => b64url(crypto.getRandomValues(new Uint8Array(size)))
const redirectUri = () => `${location.origin}${location.pathname}`

const discover = async (): Promise<{ authorization_endpoint: string; token_endpoint: string }> => {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error('无法读取登录服务配置')
  return res.json()
}

export const accessToken = (): string | null => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as { token: string; expires_at: number } | null
    return saved && saved.expires_at > Date.now() ? saved.token : null
  } catch {
    return null
  }
}

export async function login(): Promise<void> {
  sessionStorage.removeItem(TOKEN_KEY)
  const verifier = random(32)
  const state = random(16)
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, hash: location.hash }))
  const { authorization_endpoint } = await discover()
  location.assign(`${authorization_endpoint}?${new URLSearchParams({
    response_type: 'code', client_id: clientId!, redirect_uri: redirectUri(), scope: 'openid',
    state, code_challenge: challenge, code_challenge_method: 'S256',
  })}`)
}

/** 登录回跳时用授权码换 token；不是回跳则什么都不做。 */
export async function completeLogin(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const code = params.get('code')
  if (!code && !params.has('error')) return
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null') as { verifier: string; state: string; hash: string } | null
  sessionStorage.removeItem(PKCE_KEY)
  history.replaceState(null, '', `${location.pathname}${saved?.hash ?? ''}`)
  if (!code || !saved || params.get('state') !== saved.state) throw new Error('登录回跳无效，请重新登录')
  const { token_endpoint } = await discover()
  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
      client_id: clientId!, code_verifier: saved.verifier,
    }),
  })
  if (!res.ok) throw new Error('登录换取令牌失败')
  const body = (await res.json()) as { access_token: string; expires_in: number }
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 }))
}

export const authHeaders = (): Record<string, string> => {
  const token = accessToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}
