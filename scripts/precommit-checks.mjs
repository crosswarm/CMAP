/**
 * pre-commit 的纯检查逻辑，与 git 调用分离。
 *
 * 分离的理由：这些规则需要被测试，而混入 git 交互后测试只能依赖真实
 * 仓库状态，或者退化成 mock 自己——两者都测不出规则本身对不对。
 * git 交互留在 git-precommit.mjs。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// ------------------------------------------------------------ 禁止入库

const FORBIDDEN_PATHS = [
  // 凭据与环境
  { re: /(^|\/)\.env(\.|$)/i, why: '环境文件可能含真实凭据' },
  { re: /\.(pem|key|p12|pfx|jks)$/i, why: '私钥或证书' },
  { re: /(^|\/)auth\.json$/i, why: '认证凭据' },
  { re: /[^/]*(token|credential|secret|cookie)[^/]*\.(json|txt|ya?ml)$/i, why: '凭据文件' },
  // 运行时产物
  { re: /(^|\/)\.?artifacts\//i, why: 'Artifact 产物不入库，应进对象存储' },
  { re: /(^|\/)volumes\//i, why: '容器数据卷' },
  { re: /(^|\/)sessions\/.*\.jsonl$/i, why: 'Agent 会话记录可能含提示词正文' },
  { re: /\.log$/i, why: '日志可能含敏感内容' },
]

/** 白名单：模板文件不含真实值，必须放行 */
const ALLOWED = [/\.env\.example$/i, /\.env\.sample$/i]

export const findForbiddenPaths = (files) =>
  files.filter((f) => {
    if (ALLOWED.some((re) => re.test(f))) return false
    return FORBIDDEN_PATHS.some(({ re }) => re.test(f))
  })

export const explainForbidden = (file) => {
  const hit = FORBIDDEN_PATHS.find(({ re }) => re.test(file))
  return hit ? hit.why : '禁止入库'
}

// -------------------------------------------------------------- 凭据模式

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
  { label: 'Authorization 头明文', pattern: /Authorization\s*[:=]\s*['"]?(?:Bearer|Basic)\s+[A-Za-z0-9_\-.=]{16,}/i },
]

/** 明显是占位符或本地开发值，不算泄漏 */
const PLACEHOLDER = /(<[^>]*>|\bxxx+\b|\byour[-_]|example|placeholder|changeme|dummy|local-dev|localhost|secretref:\/\/)/i

/**
 * 只扫描新增行（+ 开头）。删除凭据是修复行为，不该被拦。
 */
export const findSecrets = (patch) => {
  const added = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n')

  return SECRET_PATTERNS.filter(({ pattern }) => {
    const m = added.match(pattern)
    if (!m) return false
    // 命中行若明显是占位符则放行
    const line = added.split('\n').find((l) => pattern.test(l)) ?? ''
    return !PLACEHOLDER.test(line)
  }).map(({ label }) => label)
}

// --------------------------------------------- 按文件定位与豁免标记

/**
 * 把 `git diff --cached` 的 patch 按文件拆开。
 * 逐文件判定才能精确报出是哪个文件泄漏，也才能支持文件级豁免。
 */
export const splitPatchByFile = (patch) => {
  const parts = []
  let current = null

  for (const line of patch.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (m) {
      if (current) parts.push(current)
      current = { file: m[2], lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) parts.push(current)

  return parts.map(({ file, lines }) => ({ file, added: lines.join('\n') }))
}

/**
 * 豁免标记：`precommit-allow-secrets: <理由>`
 *
 * 必须带理由——空标记不生效。理由会留在代码里，review 时能看到为什么
 * 豁免，也让「顺手加个标记绕过」这件事有成本。
 *
 * 刻意不按目录豁免（例如整个 tests/）：那样真凭据混进测试文件就查不出来了。
 */
export const hasSecretExemption = (content) =>
  /precommit-allow-secrets\s*:\s*\S+/.test(content)

/**
 * 逐文件检测泄漏，返回 [{file, labels}]。带豁免标记的文件跳过。
 */
export const findSecretsByFile = (patch) =>
  splitPatchByFile(patch)
    .filter(({ added }) => !hasSecretExemption(added))
    .map(({ file, added }) => ({ file, labels: findSecrets(added) }))
    .filter(({ labels }) => labels.length > 0)

// ----------------------------------------- 生成文件与 Schema 的一致性

/**
 * generated/ 下的类型由 schemas/ 派生。若改了 schema 却没跑 codegen，
 * 或者有人手改了生成文件，契约与类型就会静默错位——类型检查照样通过，
 * 但运行时校验与编译期约束说的不是一回事。
 *
 * 这里做轻量核对：每个 schema 必须有对应的 generated 文件，且后者
 * 必须带「自动生成」标记（手改通常会连同标记一起被覆盖或删除）。
 * 完整比对由 `npm run codegen && git diff --exit-code` 承担。
 */
const GENERATED_MAP = [
  { schema: 'task-envelope.v1.schema.json', generated: 'task-envelope.ts' },
  { schema: 'task-result.v1.schema.json', generated: 'task-result.ts' },
  { schema: 'review-decision.v1.schema.json', generated: 'review-decision.ts' },
]

export const findHandEditedGenerated = async (root) => {
  const schemaDir = join(root, 'schemas')
  const genDir = join(root, 'packages/domain-model/src/generated')
  const problems = []

  let genFiles
  try {
    genFiles = await readdir(genDir)
  } catch {
    return [`生成目录不存在：${genDir}`]
  }

  for (const { schema, generated } of GENERATED_MAP) {
    try {
      await readFile(join(schemaDir, schema), 'utf8')
    } catch {
      problems.push(`schema 缺失：${schema}`)
      continue
    }

    if (!genFiles.includes(generated)) {
      problems.push(`${generated} 缺失，需运行 npm run codegen`)
      continue
    }

    const content = await readFile(join(genDir, generated), 'utf8')
    if (!content.includes('自动生成')) {
      problems.push(`${generated} 缺少自动生成标记，疑似被手改`)
    }
    if (!content.includes(schema)) {
      problems.push(`${generated} 未标注来源 schema，疑似被手改`)
    }
  }

  return problems
}
