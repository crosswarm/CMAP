/**
 * Codex 沙箱自检（P4-05b）：权限档的拒绝条目不生效时（例如某平台的沙箱后端忽略了 deny），
 * health 必须报 unavailable，而不是任务照跑、隔离悄悄失效。
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'

const outputSchemaPath = join(process.cwd(), 'schemas/codex-output.v1.schema.json')

/** 假 codex：`sandbox` 子命令不加任何隔离、直接执行 `--` 之后的命令——模拟 deny 被静默忽略。 */
const unsandboxedCodex = async (root: string): Promise<string> => {
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('codex-cli fake'); process.exit(0) }
const cwd = args[args.indexOf('-C') + 1]
const cmd = args.slice(args.indexOf('--') + 1)
const r = require('node:child_process').spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: 'inherit' })
process.exit(r.status ?? 1)
`)
  await chmod(bin, 0o755)
  return bin
}

test('沙箱拒绝条目不生效时 health 报 unavailable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-selfcheck-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = await unsandboxedCodex(root)
  const health = await new CodexAdapter({ authorization: { mode: 'standalone' }, bin, outputSchemaPath, sandboxSelfCheck: true }).health()
  assert.equal(health.state, 'unavailable')
  assert.match(health.detail ?? '', /沙箱自检未通过.*DENY_BROKEN/s)
})

test('未开启自检时行为不变（测试与脚本用的假 codex 不支持 sandbox 子命令）', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-selfcheck-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = await unsandboxedCodex(root)
  assert.equal((await new CodexAdapter({ authorization: { mode: 'standalone' }, bin, outputSchemaPath }).health()).state, 'healthy')
})

test('真实 codex 的权限档在本平台生效（macOS seatbelt / Linux bwrap）', async (t) => {
  try { await promisify(execFile)('codex', ['--version']) } catch { return t.skip('无 codex CLI') }
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, outputSchemaPath, sandboxSelfCheck: true })
  const health = await adapter.health()
  assert.equal(health.state, 'healthy', health.detail ?? '')
  assert.equal((await adapter.health()).state, 'healthy', '通过后进程内复用')
})
