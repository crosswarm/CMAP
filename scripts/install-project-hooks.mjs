#!/usr/bin/env node
/**
 * 为当前 clone 启用仓库自带的 git hooks。
 *
 * 用 core.hooksPath 指向 .githooks/，这样 hook 随仓库版本管理，
 * 不必每人手动复制到 .git/hooks/。
 *
 * 用法：node scripts/install-project-hooks.mjs
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hooksDir = join(root, '.githooks')

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root })

for (const f of readdirSync(hooksDir)) {
  chmodSync(join(hooksDir, f), 0o755)
}

console.log('已启用仓库 hooks：core.hooksPath = .githooks')
console.log(`可执行钩子：${readdirSync(hooksDir).join(', ')}`)
