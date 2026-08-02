#!/usr/bin/env node
/**
 * pre-commit 检查入口。检查规则本身在 precommit-checks.mjs（可测试），
 * 这里只负责与 git 交互。
 *
 * 用法：node scripts/git-precommit.mjs --staged
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  findForbiddenPaths,
  explainForbidden,
  findSecretsByFile,
  findHandEditedGenerated,
} from './precommit-checks.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)

if (staged.length === 0) process.exit(0)

const failures = []

// 1. 禁止入库的路径
const forbidden = findForbiddenPaths(staged)
for (const f of forbidden) {
  failures.push(`禁止入库：${f}（${explainForbidden(f)}）`)
}

// 2. 新增内容中的凭据（逐文件定位；带 precommit-allow-secrets 标记的跳过）
const patch = git(['diff', '--cached', '--unified=0', '--no-ext-diff'])
for (const { file, labels } of findSecretsByFile(patch)) {
  failures.push(`疑似凭据泄漏：${file} → ${labels.join('、')}`)
}

// 3. 生成文件与 schema 的一致性——仅在相关文件被改动时检查
const touchesContract = staged.some(
  (f) => f.startsWith('schemas/') || f.includes('domain-model/src/generated/'),
)
if (touchesContract) {
  for (const p of await findHandEditedGenerated(root)) {
    failures.push(`契约一致性：${p}`)
  }
}

if (failures.length > 0) {
  console.error('\npre-commit 检查未通过：\n')
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error(
    '\n如果确认是误报，请修正检查规则（scripts/precommit-checks.mjs）并补测试，' +
      '\n不要用 --no-verify 绕过——绕过会让这道防线在真正需要时同样失效。\n',
  )
  process.exit(1)
}
