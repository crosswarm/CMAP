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
import { buildCodexArgs, InvalidEffortError } from '../../adapters/codex-adapter/src/index.ts'

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
    assert.equal(valueOf(args, '-s'), 'workspace-write')
    assert.ok(!args.includes('danger-full-access'))
  })
})
