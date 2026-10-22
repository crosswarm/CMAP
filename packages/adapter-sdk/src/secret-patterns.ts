// Shared known credential patterns. Runtime consumers must not apply Git exemptions.
export const SECRET_PATTERNS = [
  { label: 'OpenAI/Anthropic API key', pattern: /\b(sk|pk)-[A-Za-z0-9_-]{20,}/ },
  { label: '私钥块', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: 'AWS Access Key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  {
    label: 'Host API token 赋值',
    pattern: /\b[A-Z_]*(?:API_TOKEN|ACCESS_TOKEN|SECRET_KEY|PRIVATE_TOKEN)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{12,}/,
  },
  {
    label: '凭据变量赋值',
    pattern: /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{16,}/,
  },
  { label: 'URL 内嵌口令', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]*:[^\s:/@'"]+@[^\s/'"]*/i },
  { label: 'Authorization 头明文', pattern: /Authorization\s*[:=]\s*['"]?(?:Bearer|Basic)\s+[A-Za-z0-9_\-.=]{16,}/i },
]

export const hasKnownSecret = (text: string): boolean =>
  SECRET_PATTERNS.some(({ pattern }) => pattern.test(text))
