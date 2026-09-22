const BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const

const CODEX_ENV_KEYS = [
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
] as const

export const providerBaseEnv = (
  source: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const key of BASE_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key.startsWith('LC_')) env[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

export const codexProviderEnv = (
  source: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const env = providerBaseEnv(source)
  for (const key of CODEX_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value
  }
  return env
}
