// precommit-allow-secrets: 本文件必须包含真实格式的凭据样本，否则无法验证检测逻辑；以下均为构造值，非真实凭据
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  findForbiddenPaths,
  findSecrets,
  findSecretsByFile,
  splitPatchByFile,
  hasSecretExemption,
  findHandEditedGenerated,
  SECRET_PATTERNS,
} from '../../scripts/precommit-checks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')

/**
 * pre-commit 的检查逻辑与 git 调用分离：
 * 纯函数在这里测，git 交互留给 hook 脚本。
 * 否则测试要么依赖真实 git 状态，要么退化成 mock 自己。
 */

describe('禁止入库的路径', () => {
  test('拦截 .env 及其变体', () => {
    for (const f of ['.env', '.env.local', 'apps/api/.env.production']) {
      assert.deepEqual(findForbiddenPaths([f]), [f], `${f} 应被拦截`)
    }
  })

  test('放行 .env.example（模板不含真实值）', () => {
    assert.deepEqual(findForbiddenPaths(['.env.example']), [])
    assert.deepEqual(findForbiddenPaths(['infra/docker-compose/.env.example']), [])
  })

  test('拦截私钥与证书', () => {
    for (const f of ['ca.pem', 'certs/server.key', 'runner.p12']) {
      assert.deepEqual(findForbiddenPaths([f]), [f], `${f} 应被拦截`)
    }
  })

  test('拦截 Artifact 与运行时产物', () => {
    for (const f of ['.artifacts/x.json', 'artifacts/trace.zip', 'infra/docker-compose/volumes/pg/x']) {
      assert.deepEqual(findForbiddenPaths([f]), [f], `${f} 应被拦截`)
    }
  })

  test('拦截 Agent 会话记录与凭据文件', () => {
    for (const f of ['sessions/rollout-2026.jsonl', 'auth.json', 'x-token.json', 'my-cookie.txt']) {
      assert.deepEqual(findForbiddenPaths([f]), [f], `${f} 应被拦截`)
    }
  })

  test('放行正常源码', () => {
    const ok = [
      'packages/domain-model/src/entities.ts',
      'schemas/task-envelope.v1.schema.json',
      'docs/architecture.md',
      'tests/contract/schemas.test.mjs',
    ]
    assert.deepEqual(findForbiddenPaths(ok), [])
  })
})

describe('凭据模式检测', () => {
  test('检出 OpenAI 风格 key', () => {
    const patch = `+const key = "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`
    assert.ok(findSecrets(patch).length > 0)
  })

  test('检出私钥块', () => {
    const patch = `+-----BEGIN RSA PRIVATE KEY-----`
    assert.ok(findSecrets(patch).length > 0)
  })

  test('检出 JWT', () => {
    const patch = `+const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop"`
    assert.ok(findSecrets(patch).length > 0)
  })

  test('检出 YonWork Host token 赋值', () => {
    const patch = `+YONCLAW_HOST_API_TOKEN=abc123def456ghi789`
    assert.ok(findSecrets(patch).length > 0)
  })

  test('secretref:// 引用不算泄漏（正是我们要求的写法）', () => {
    const patch = `+  "account_ref": "secretref://yonwork/perf-test-user"`
    assert.deepEqual(findSecrets(patch), [])
  })

  test('占位符与示例值不误报', () => {
    const patch = [
      `+POSTGRES_PASSWORD: temporal`,
      `+  token: 'local-dev-token'`,
      `+TEMPORAL_ADDRESS=localhost:7233`,
      `+# TOKEN=<your-token-here>`,
    ].join('\n')
    assert.deepEqual(findSecrets(patch), [], '本地开发占位值不应误报')
  })

  test('只检查新增行，删除行不算', () => {
    const patch = `-const key = "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`
    assert.deepEqual(findSecrets(patch), [], '删除凭据是好事，不该被拦')
  })

  test('模式表非空且每项都有可读标签', () => {
    assert.ok(SECRET_PATTERNS.length > 0)
    for (const p of SECRET_PATTERNS) {
      assert.ok(typeof p.label === 'string' && p.label.length > 0)
      assert.ok(p.pattern instanceof RegExp)
    }
  })
})

describe('按文件定位泄漏与豁免标记', () => {
  const PATCH = [
    'diff --git a/src/leak.ts b/src/leak.ts',
    '--- a/src/leak.ts',
    '+++ b/src/leak.ts',
    '@@ -0,0 +1 @@',
    '+const k = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"',
    'diff --git a/tests/sample.test.mjs b/tests/sample.test.mjs',
    '--- a/tests/sample.test.mjs',
    '+++ b/tests/sample.test.mjs',
    '@@ -0,0 +2 @@',
    '+// precommit-allow-secrets: 检测逻辑的测试样本，非真实凭据',
    '+const fixture = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"',
  ].join('\n')

  test('能把 patch 按文件拆开', () => {
    const parts = splitPatchByFile(PATCH)
    assert.deepEqual(
      parts.map((p) => p.file).sort(),
      ['src/leak.ts', 'tests/sample.test.mjs'],
    )
  })

  test('识别文件内的豁免标记', () => {
    assert.equal(hasSecretExemption('+// precommit-allow-secrets: 理由'), true)
    assert.equal(hasSecretExemption('+const x = 1'), false)
  })

  test('豁免标记必须带理由，空标记不生效', () => {
    assert.equal(hasSecretExemption('+// precommit-allow-secrets'), false)
    assert.equal(hasSecretExemption('+// precommit-allow-secrets:'), false)
    assert.equal(hasSecretExemption('+// precommit-allow-secrets:   '), false)
  })

  test('真实泄漏被报出且定位到文件', () => {
    const hits = findSecretsByFile(PATCH)
    const files = hits.map((h) => h.file)
    assert.ok(files.includes('src/leak.ts'), '未豁免的文件必须报出')
  })

  test('带豁免标记的测试样本不报警', () => {
    const hits = findSecretsByFile(PATCH)
    const files = hits.map((h) => h.file)
    assert.ok(
      !files.includes('tests/sample.test.mjs'),
      '带理由的豁免标记应生效，否则测试文件无法包含检测样本',
    )
  })

  test('仅凭位于 tests/ 目录不豁免——必须显式标记', () => {
    const patch = [
      'diff --git a/tests/other.test.mjs b/tests/other.test.mjs',
      '+++ b/tests/other.test.mjs',
      '+const real = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"',
    ].join('\n')
    const hits = findSecretsByFile(patch)
    assert.ok(
      hits.some((h) => h.file === 'tests/other.test.mjs'),
      '目录不是豁免依据，否则真凭据混进测试文件就查不出来了',
    )
  })
})

describe('生成文件与 Schema 的一致性', () => {
  test('当前仓库状态下 generated 与 schema 一致', async () => {
    const drift = await findHandEditedGenerated(root)
    assert.deepEqual(
      drift,
      [],
      `以下生成文件与 schema 不一致，需重新运行 npm run codegen：${drift.join(', ')}`,
    )
  })

  test('能检出 schema 改动后未重新生成的情况', async () => {
    // 传入一个不存在的目录，函数应报告缺失而非静默通过——
    // 静默通过意味着这个检查形同虚设
    const drift = await findHandEditedGenerated(join(root, 'no-such-dir'))
    assert.ok(drift.length > 0, '目录缺失时必须报告，不得静默放行')
  })
})
