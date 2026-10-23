/**
 * codex CLI 参数构造契约。
 *
 * 测纯函数而非 spawn 真进程：参数构造是有分支的逻辑（沙箱档位、
 * model_policy 有无），而它出错的表现恰恰是「命令照跑不误、结果却不对」——
 * 实测过 codex 对非法 model_reasoning_effort 静默接受，不报错也不退出。
 * 这类错误只能在参数层拦。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import type { TaskEnvelopeV1 } from '#domain-model'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { buildCodexArgs, homeReadDenials, homeToolchainRoots, InvalidEffortError } from '../../adapters/codex-adapter/src/index.ts'
import { GIT_HOOKS_DIR } from '../../packages/adapter-sdk/src/push-guard.ts'

const SHA40 = 'e35a48a1b2c3d4e5f60718293a4b5c6d7e8f9012'

const envelope = (
  modelPolicy?: TaskEnvelopeV1['execution_policy']['model_policy'],
): TaskEnvelopeV1 => ({
  schema: 'cmap/task-envelope/v1',
  identity: {
    mission_id: 'mis-1', task_id: 'tsk-1', parent_task_id: null,
    supersedes_task_id: null, idempotency_key: 'mis-1:tsk-1:1', revision: 1,
  },
  classification: {
    task_type: 'code.implement',
    requested_capability: 'code.implement',
    risk_level: 'read-meta',
  },
  goal: {
    statement: '实现 X',
    success_definition: [
      { criterion_id: 'C1', metric: 'tests_pass', operator: 'eq', expected: true },
    ],
  },
  inputs: { context: { repo: 'git@github.com:crosswarm/app.git', ref: SHA40 } },
  environment: {},
  execution_policy: {
    timeout_seconds: 600,
    max_attempts: 1,
    ...(modelPolicy ? { model_policy: modelPolicy } : {}),
  },
  permissions: { forbidden: [] },
  evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
}) as TaskEnvelopeV1

const opts = {
  workDir: '/tmp/wd',
  resultFile: '/tmp/wd/result.json',
  outputSchemaPath: '/schemas/codex-output.v1.json',
  prompt: '干活',
}

/** 取 flag 的下一个元素，flag 不存在时返回 null */
const valueOf = (args: readonly string[], flag: string): string | null => {
  const i = args.indexOf(flag)
  return i === -1 ? null : (args[i + 1] ?? null)
}

describe('模型与努力度落到命令行', () => {
  test('带 model_policy 时传 -m 与 model_reasoning_effort', () => {
    const args = buildCodexArgs(
      envelope({ model: 'gpt-5.6-sol', effort: 'xhigh', source: 'task_override' }),
      opts,
    )
    assert.equal(valueOf(args, '-m'), 'gpt-5.6-sol')
    assert.ok(
      args.includes('model_reasoning_effort="xhigh"'),
      `-c 的值须是 TOML 字面量（带引号），实际参数：${JSON.stringify(args)}`,
    )
  })

  test('不带 model_policy 时不传这两项——沿用 codex 自身默认', () => {
    const args = buildCodexArgs(envelope(), opts)
    assert.equal(valueOf(args, '-m'), null)
    assert.ok(
      !args.some((a) => a.startsWith('model_reasoning_effort')),
      '不该凭空造一个默认档位——那会悄悄覆盖用户在 config.toml 里的设置',
    )
  })

  test('runner 配置了默认模型（lap 的 CMAP_CODEX_MODEL）时无 model_policy 也显式传 -m，不依赖 ~/.codex 默认', () => {
    const args = buildCodexArgs(envelope(), { ...opts, defaultModel: 'gpt-5.6-lap' })
    assert.equal(valueOf(args, '-m'), 'gpt-5.6-lap')
    assert.equal(args.filter((a) => a === '-m').length, 1)
    assert.ok(!args.some((a) => a.startsWith('model_reasoning_effort')))
    // 信封显式解析出的 model_policy 优先于 runner 默认
    const policy = buildCodexArgs(envelope({ model: 'gpt-5.6-sol', effort: 'low', source: 'task_override' }), { ...opts, defaultModel: 'gpt-5.6-lap' })
    assert.equal(valueOf(policy, '-m'), 'gpt-5.6-sol')
    assert.equal(policy.filter((a) => a === '-m').length, 1)
  })

  test('四档都能构造', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      const args = buildCodexArgs(
        envelope({ model: 'gpt-5.6-sol', effort, source: 'agent_default' }),
        opts,
      )
      assert.ok(args.includes(`model_reasoning_effort="${effort}"`), `档位 ${effort} 未落到参数`)
    }
  })

  test('非法档位抛错而非透传', () => {
    const bad = envelope({
      model: 'gpt-5.6-sol',
      effort: 'ultra' as never,
      source: 'agent_default',
    })
    assert.throws(
      () => buildCodexArgs(bad, opts),
      InvalidEffortError,
      'codex 收到非法档位会静默套用默认值，透传等于让任务用错误档位跑完且无人知晓',
    )
  })
})

describe('既有参数不受影响', () => {
  test('沙箱、输出 schema、结果文件、提示词都在', () => {
    const args = buildCodexArgs(envelope(), opts)
    assert.equal(args[0], 'exec')
    assert.ok(args.includes('--ignore-user-config'), '任务 Agent 不得继承个人插件、hooks 与额外 writable roots')
    assert.ok(args.includes('--ephemeral'), '一次性任务不得留下可恢复的本机会话')
    assert.equal(valueOf(args, '--output-schema'), opts.outputSchemaPath)
    assert.equal(valueOf(args, '-o'), opts.resultFile)
    assert.equal(valueOf(args, '-C'), opts.workDir)
    assert.equal(args.at(-1), opts.prompt, '提示词必须是最后一个位置参数')
  })

  test('声明了证据产物就要能写工作区，绝不使用 danger-full-access', () => {
    const args = buildCodexArgs(envelope(), opts)
    assert.ok(configs(args).includes('default_permissions="cmap"'), '必须显式选定 CMAP 权限档，不继承本机默认')
    assert.ok(configs(args).includes('permissions.cmap.extends=":workspace"'))
    assert.ok(!args.some((a) => a.includes('danger-full-access')))
  })
})

/** 所有 -c 的值 */
const configs = (args: readonly string[]): string[] =>
  args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []))

/** 契约要求至少一个证据角色；只读档只在旧信封/直接调用时出现，这里绕过类型构造。 */
const readOnlyEnvelope = (): TaskEnvelopeV1 =>
  ({ ...envelope(), evidence_requirements: { required_artifact_roles: [] } }) as unknown as TaskEnvelopeV1

describe('读取范围（P4-05b / T7）', () => {
  test('不传 -s：-s 会让 codex 退回旧沙箱设置，旧设置可读整个磁盘', () => {
    for (const e of [envelope(), readOnlyEnvelope()]) {
      assert.equal(buildCodexArgs(e, opts).includes('-s'), false)
    }
  })

  test('workspace-write 档默认拒绝读写整个 ~，工作区与 TMPDIR 由 :workspace 更具体的条目放行', () => {
    assert.ok(configs(buildCodexArgs(envelope(), opts)).includes('permissions.cmap.filesystem={"~"="deny"}'))
  })

  test('read-only 档同样拒绝 HOME，并显式授予工作区读取（工作区可能在 HOME 下）', () => {
    const c = configs(buildCodexArgs(readOnlyEnvelope(), opts))
    assert.ok(c.includes('permissions.cmap.extends=":read-only"'))
    assert.ok(c.includes('permissions.cmap.filesystem={"~"="deny",":workspace_roots"={"."="read"}}'))
  })

  test('拒绝清单按路径逐条落成 TOML 键（JSON 字符串转义即 TOML 基本字符串）', () => {
    const c = configs(buildCodexArgs(envelope(), { ...opts, homeDenials: ['/h/.ssh', '/h/a "b"'] }))
    assert.ok(c.includes('permissions.cmap.filesystem={"/h/.ssh"="deny","/h/a \\"b\\""="deny"}'), JSON.stringify(c))
  })
})

describe('沙箱内 git 环境（P4-05b / P4-06）', () => {
  test('经 shell_environment_policy.set 注入：不读个人 git 配置，hooksPath 指向 CMAP pre-push，信封推送规则', () => {
    const withRepo = { ...envelope(), permissions: { forbidden: [], repository: { allow_push_branches: ['feat/*'] } } } as TaskEnvelopeV1
    const set = configs(buildCodexArgs(withRepo, opts)).find((c) => c.startsWith('shell_environment_policy.set='))
    assert.equal(set, `shell_environment_policy.set={GIT_CONFIG_GLOBAL="/dev/null",GIT_CONFIG_COUNT="1",` +
      `GIT_CONFIG_KEY_0="core.hooksPath",GIT_CONFIG_VALUE_0=${JSON.stringify(GIT_HOOKS_DIR)},CMAP_PUSH_ALLOW="feat/*",CMAP_PUSH_DENY="main release/*"}`)
  })
})

describe('homeReadDenials：只放行 keep 及其祖先目录', () => {
  const tree = async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'cmap-home-')))
    for (const d of ['.ssh', 'work/t1', 'work/t2', 'work/.runs', 'tools/bin']) await mkdir(join(home, d), { recursive: true })
    await writeFile(join(home, '.netrc'), 'x')
    await writeFile(join(home, 'work', 'note'), 'x')
    await symlink(join(home, '.ssh'), join(home, 'link-ssh'))
    return home
  }

  test('工作区在 HOME 下：兄弟条目（含其他任务工作区、运行记录、HOME 根下文件）全拒，祖先目录与符号链接不列入', async (t) => {
    const home = await tree()
    t.after(() => rm(home, { recursive: true, force: true }))
    const denied = await homeReadDenials(home, [join(home, 'work/t1'), join(home, 'tools')])
    assert.deepEqual(denied.sort(), ['.netrc', '.ssh', 'work/.runs', 'work/note', 'work/t2'].map((p) => join(home, p)).sort())
  })

  test('keep 都不在 HOME 下：直接拒绝整个 ~', async (t) => {
    const home = await tree()
    t.after(() => rm(home, { recursive: true, force: true }))
    assert.deepEqual(await homeReadDenials(home, ['/private/tmp/x']), ['~'])
  })
})

describe('homeToolchainRoots：PATH 中 HOME 下的目录', () => {
  test('Homebrew 前缀整体放行，其他 bin 目录只放行自身，HOME 外与不存在的目录忽略', async (t) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'cmap-path-')))
    t.after(() => rm(home, { recursive: true, force: true }))
    for (const d of ['.homebrew/bin', '.homebrew/Cellar', '.codex/bin', 'bin']) await mkdir(join(home, d), { recursive: true })
    const path = [join(home, '.homebrew/bin'), join(home, '.codex/bin'), join(home, 'bin'), '/usr/bin', join(home, 'missing')].join(delimiter)
    assert.deepEqual(await homeToolchainRoots(home, path), [join(home, '.homebrew'), join(home, '.codex/bin'), join(home, 'bin')])
  })
})
