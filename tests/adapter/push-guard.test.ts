/**
 * P4-06：信封 permissions.repository 的推送限制落到 git pre-push hook（真实 git + 本地 bare 远端）。
 *
 * 这道 hook 只防「失控但非恶意」的推送：Agent 可以 `--no-verify` 或清掉环境变量绕过，
 * 硬边界仍是沙箱（Codex 无网络、两者都不能写工作区外的仓库）与 Agent 拿不到推送凭据，见威胁模型 T1。
 */
import { execFile } from 'node:child_process'
import { access, constants, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TaskEnvelopeV1 } from '#domain-model'
import { GIT_HOOKS_DIR, pushGuardEnv } from '../../packages/adapter-sdk/src/push-guard.ts'

const exec = promisify(execFile)

const repoPerms = (repository?: Record<string, unknown>) =>
  ({ permissions: { forbidden: [], ...(repository ? { repository } : {}) } }) as unknown as Pick<TaskEnvelopeV1, 'permissions'>

/** 建 bare 远端 + 一个带一次提交的工作仓库，返回推送函数（成功 true / 被拒 false）。 */
const fixture = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cmap-push-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  await git(root, 'init', '-q', '--bare', 'remote.git')
  await git(root, 'init', '-q', '-b', 'main', 'work')
  const work = join(root, 'work')
  await git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  await git(work, 'remote', 'add', 'origin', join(root, 'remote.git'))
  const push = async (env: NodeJS.ProcessEnv, ref: string): Promise<{ ok: boolean; stderr: string }> => {
    try {
      await exec('git', ['push', 'origin', ref], { cwd: work, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...env } })
      return { ok: true, stderr: '' }
    } catch (e) {
      return { ok: false, stderr: String((e as { stderr?: string }).stderr) }
    }
  }
  return Object.assign(push, { work, git })
}

test('hook 文件随仓库提供且可执行', async () => {
  await access(join(GIT_HOOKS_DIR, 'pre-push'), constants.X_OK)
})

test('没有 allow_push_branches：一律拒绝推送（含默认 deny 之外的分支与标签）', async (t) => {
  const push = await fixture(t)
  const env = pushGuardEnv(repoPerms())
  for (const ref of ['HEAD:main', 'HEAD:release/1.0', 'HEAD:feat/x', 'HEAD:refs/tags/v1']) {
    const r = await push(env, ref)
    assert.equal(r.ok, false, ref)
    assert.match(r.stderr, /cmap: 拒绝推送/, ref)
  }
  // 对照：不注入 hook 时同一推送成功，证明拒绝来自 hook 而非仓库本身
  assert.equal((await push({}, 'HEAD:feat/x')).ok, true)
})

test('allow_push_branches 放行匹配分支；deny_push（缺省 main、release/*）优先于 allow', async (t) => {
  const push = await fixture(t)
  const env = pushGuardEnv(repoPerms({ allow_push_branches: ['feat/*', 'main', 'release/*'] }))
  assert.equal((await push(env, 'HEAD:feat/x')).ok, true)
  assert.equal((await push(env, 'HEAD:main')).ok, false)
  assert.equal((await push(env, 'HEAD:release/2.0')).ok, false)
  assert.equal((await push(env, 'HEAD:other')).ok, false)
})

test('显式 deny_push 替换缺省清单；含空白的 allow 模式被丢弃而不是拆开放宽', async (t) => {
  const push = await fixture(t)
  const env = pushGuardEnv(repoPerms({ allow_push_branches: ['*', 'x y'], deny_push: ['prod'] }))
  assert.equal(env['CMAP_PUSH_ALLOW'], '*')
  assert.equal((await push(env, 'HEAD:main')).ok, true)
  assert.equal((await push(env, 'HEAD:prod')).ok, false)
})

test('hooksPath 走命令级配置（GIT_CONFIG_*），仓库自己的 core.hooksPath 盖不住', async (t) => {
  const push = await fixture(t)
  // Agent 改仓库 config（Kimi 可写工作区 .git）把 hooksPath 指向空目录，仍被 CMAP hook 拒绝
  await push.git(push.work, 'config', 'core.hooksPath', push.work)
  const r = await push(pushGuardEnv(repoPerms()), 'HEAD:feat/x')
  assert.equal(r.ok, false)
  assert.match(r.stderr, /cmap: 拒绝推送/)
})
