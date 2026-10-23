import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DispatchContext } from '#adapter-sdk'
import type { RemoteTaskBinding, TaskEnvelopeV1 } from '#domain-model'
import { DispatchPermitError, issueDispatchPermit, verifyDispatchPermit } from '#domain-model'
import { CodexAdapter } from '../../adapters/codex-adapter/src/index.ts'
import './isolated-home.ts'

const envelope: TaskEnvelopeV1 = {
  schema: 'cmap/task-envelope/v1',
  identity: { mission_id: 'mis-idempotence', task_id: 'tsk-idempotence', revision: 1, idempotency_key: 'codex-idempotence' },
  classification: { task_type: 'inspect', requested_capability: 'code.analyze', risk_level: 'read-meta' },
  goal: { statement: 'check', success_definition: [{ criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true }] },
  environment: {}, execution_policy: { timeout_seconds: 30, max_attempts: 1 },
  permissions: { forbidden: [] }, evidence_requirements: { required_artifact_roles: ['report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
}

const context = (worktree: string): DispatchContext => ({
  token: 'test', runner_id: 'runner-test', trace_id: 'trace-test', correlation_id: 'correlation-test',
  worktree, deadline_at: new Date(Date.now() + 30_000).toISOString(),
})

const permitTrust = (adapterId: string, runnerId = 'runner-test') => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const issuer = 'adapter-test-control'
  const issuedMs = 1_800_000_000_000
  let nowMs = issuedMs
  return {
    expire: () => { nowMs = issuedMs + 1_000 },
    issue: (e: TaskEnvelopeV1) => issueDispatchPermit({
      privateKey, issuer, runnerId, adapterId, envelope: e, nowMs: issuedMs, ttlSeconds: 1,
    }),
    verifier: (token: string, e: TaskEnvelopeV1, actualAdapterId: string, actualRunnerId: string) =>
      verifyDispatchPermit(token, {
        publicKey, issuer, runnerId: actualRunnerId, adapterId: actualAdapterId, envelope: e, nowMs,
      }),
  }
}

test('Codex prepareBinding is deterministic and does not touch the worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-prepare-'))
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin: join(root, 'missing-codex'), outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  try {
    const before = await readdir(root)
    const binding = adapter.prepareBinding(envelope, context(root))
    const again = adapter.prepareBinding(envelope, context(root))
    assert.deepEqual(binding, again)
    assert.deepEqual(binding, {
      adapter: 'codex-adapter',
      remote_task_id: 'codex:tsk-idempotence:1',
      protocol: 'codex-exec',
      protocol_version: '0.1.0',
      runner_id: 'runner-test',
    })
    assert.deepEqual(await readdir(root), before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('concurrent Codex starts launch once and cleanup preserves the binding tombstone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-idempotence-'))
  const launches = join(root, 'launches')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(launches)}, String(process.pid) + '\\n')\n`)
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  const prepared = adapter.prepareBinding(envelope, context(root))
  assert.deepEqual(prepared, {
    adapter: 'codex-adapter',
    remote_task_id: 'codex:tsk-idempotence:1',
    protocol: 'codex-exec',
    protocol_version: '0.1.0',
    runner_id: 'runner-test',
  })
  try {
    const bindings = await Promise.all(Array.from({ length: 8 }, () => adapter.startTask(envelope, context(root))))
    for (const binding of bindings) assert.deepEqual(binding, bindings[0])
    const binding = bindings[0]!
    assert.deepEqual(binding, prepared)
    const deadline = Date.now() + 5000
    while (!(await adapter.getStatus(binding)).terminal_observed) {
      assert.ok(Date.now() < deadline, 'fake CLI did not terminate')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal((await readFile(launches, 'utf8')).trim().split('\n').length, 1)
    await adapter.cleanup(binding)
    assert.deepEqual(await adapter.startTask(envelope, context(root)), binding)
    await assert.rejects(adapter.getStatus(binding), { code: 'BINDING_NOT_FOUND' })
    assert.equal((await readFile(launches, 'utf8')).trim().split('\n').length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex failed preparation clears pending launch so a corrected retry can start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-preparation-'))
  const worktree = join(root, 'work')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}\nprocess.exit(0)\n`)
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  try {
    await assert.rejects(adapter.startTask(envelope, context(worktree)), { code: 'ENOENT' })
    await mkdir(worktree)
    const binding = await adapter.startTask(envelope, context(worktree))
    const deadline = Date.now() + 5000
    while (!(await adapter.getStatus(binding)).terminal_observed) {
      assert.ok(Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await adapter.cleanup(binding)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex beforeSend rejection blocks process launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-before-send-'))
  const launches = join(root, 'launches')
  const keep = join(root, 'keep.txt')
  const callerPrompt = join(root, '.cmap-prompt-tsk-idempotence.md')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(keep, 'caller-owned')
  await writeFile(callerPrompt, 'caller prompt')
  await writeFile(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(launches)}, String(process.pid) + '\\n')\n`)
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  try {
    await assert.rejects(
      adapter.startTask(envelope, {
        ...context(root),
        beforeSend: async () => { throw new Error('blocked') },
      }),
      /blocked/,
    )
    await assert.rejects(readFile(launches, 'utf8'), { code: 'ENOENT' })
    assert.equal(await readFile(callerPrompt, 'utf8'), 'caller prompt')
    assert.equal(await readFile(keep, 'utf8'), 'caller-owned')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex beforeSend rejection removes only adapter-owned temporary workdir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-owned-cleanup-'))
  const launches = join(root, 'launches')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(launches)}, String(process.pid) + '\\n')\n`)
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  // 独立 TMPDIR：全量测试并行时其他文件也会在系统临时目录建 cmap-codex-* 目录，
  // 对系统临时目录做前后快照会把别人的目录误判为泄漏。Adapter 调用时才读 tmpdir()，这里改环境变量即生效。
  const privateTmp = join(root, 'tmp')
  await mkdir(privateTmp)
  const previousTmp = process.env['TMPDIR']
  process.env['TMPDIR'] = privateTmp
  try {
    await assert.rejects(
      adapter.startTask(envelope, {
        token: 'test',
        runner_id: 'runner-test',
        trace_id: 'trace-test',
        correlation_id: 'correlation-test',
        deadline_at: new Date(Date.now() + 30_000).toISOString(),
        beforeSend: async () => { throw new Error('blocked') },
      }),
      /blocked/,
    )
    await assert.rejects(readFile(launches, 'utf8'), { code: 'ENOENT' })
    assert.deepEqual(await readdir(privateTmp), [], 'Adapter 自建的临时工作目录必须被清理')
  } finally {
    if (previousTmp === undefined) delete process.env['TMPDIR']
    else process.env['TMPDIR'] = previousTmp
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex startTask passes only provider env allowlist plus task metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-env-'))
  const envFile = join(root, 'env.json')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  path: !!process.env.PATH,
  home: !!process.env.HOME,
  codexHome: process.env.CODEX_HOME === 'codex-home-ok',
  openai: process.env.OPENAI_API_KEY === 'openai-ok',
  cmapTask: process.env.CMAP_TASK_ID === 'tsk-idempotence',
  cmapTrace: process.env.CMAP_TRACE_ID === 'trace-test',
  runnerToken: !!process.env.CMAP_RUNNER_TOKEN,
  database: !!process.env.CMAP_DATABASE_URL,
  typesafe: !!process.env.TYPESAFE_API_KEY,
  other: !!process.env.OTHER_SECRET,
  nodeOptions: !!process.env.NODE_OPTIONS
}))
`)
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  const saved = snapshotEnv(['CODEX_HOME', 'OPENAI_API_KEY', 'CMAP_RUNNER_TOKEN', 'CMAP_DATABASE_URL', 'TYPESAFE_API_KEY', 'OTHER_SECRET', 'NODE_OPTIONS'])
  Object.assign(process.env, {
    CODEX_HOME: 'codex-home-ok',
    OPENAI_API_KEY: 'openai-ok',
    CMAP_RUNNER_TOKEN: 'runner-token',
    CMAP_DATABASE_URL: 'postgres://secret',
    TYPESAFE_API_KEY: 'typesafe-secret',
    OTHER_SECRET: 'other-secret',
    NODE_OPTIONS: '--max-old-space-size=64',
  })
  try {
    const binding = await adapter.startTask(envelope, context(root))
    const deadline = Date.now() + 5000
    while (!(await adapter.getStatus(binding)).terminal_observed) {
      assert.ok(Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.deepEqual(JSON.parse(await readFile(envFile, 'utf8')), {
      path: true,
      home: true,
      codexHome: true,
      openai: true,
      cmapTask: true,
      cmapTrace: true,
      runnerToken: false,
      database: false,
      typesafe: false,
      other: false,
      nodeOptions: false,
    })
  } finally {
    restoreEnv(saved)
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex health probe uses the provider env allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-health-env-'))
  const envFile = join(root, 'health-env.json')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  path: !!process.env.PATH,
  home: !!process.env.HOME,
  codexHome: process.env.CODEX_HOME === 'codex-home-ok',
  openai: process.env.OPENAI_API_KEY === 'openai-ok',
  runnerToken: !!process.env.CMAP_RUNNER_TOKEN,
  database: !!process.env.CMAP_DATABASE_URL,
  typesafe: !!process.env.TYPESAFE_API_KEY,
  other: !!process.env.OTHER_SECRET,
  nodeOptions: !!process.env.NODE_OPTIONS
}))
console.log('codex-test')
`)
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({ authorization: { mode: 'standalone' }, bin, outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json') })
  const saved = snapshotEnv(['CODEX_HOME', 'OPENAI_API_KEY', 'CMAP_RUNNER_TOKEN', 'CMAP_DATABASE_URL', 'TYPESAFE_API_KEY', 'OTHER_SECRET', 'NODE_OPTIONS'])
  Object.assign(process.env, {
    CODEX_HOME: 'codex-home-ok',
    OPENAI_API_KEY: 'openai-ok',
    CMAP_RUNNER_TOKEN: 'runner-token',
    CMAP_DATABASE_URL: 'postgres://secret',
    TYPESAFE_API_KEY: 'typesafe-secret',
    OTHER_SECRET: 'other-secret',
    NODE_OPTIONS: '--max-old-space-size=64',
  })
  try {
    assert.equal((await adapter.health()).state, 'healthy')
    assert.deepEqual(JSON.parse(await readFile(envFile, 'utf8')), {
      path: true,
      home: true,
      codexHome: true,
      openai: true,
      runnerToken: false,
      database: false,
      typesafe: false,
      other: false,
      nodeOptions: false,
    })
  } finally {
    restoreEnv(saved)
    await rm(root, { recursive: true, force: true })
  }
})

test('managed Codex rejects malformed permit before idempotency reuse or launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-managed-first-'))
  const launches = join(root, 'launches')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(launches)}, 'spawned\\n')\n`)
  await chmod(bin, 0o755)
  const trust = permitTrust('codex-adapter')
  const adapter = new CodexAdapter({
    authorization: { mode: 'managed', verifier: trust.verifier },
    bin,
    outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
    idempotencyStore: new Map([[envelope.identity.idempotency_key, adapterBinding(root)]]),
  })
  try {
    await assert.rejects(
      adapter.startTask(envelope, {
        ...context(root),
        token: '',
        beforeSend: async () => undefined,
      }),
      (err) => err instanceof DispatchPermitError && err.code === 'MALFORMED',
    )
    await assert.rejects(readFile(launches, 'utf8'), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('managed Codex rejects a permit that expires after beforeSend and before spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-managed-final-'))
  const launches = join(root, 'launches')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(launches)}, 'spawned\\n')\n`)
  await chmod(bin, 0o755)
  const trust = permitTrust('codex-adapter')
  const adapter = new CodexAdapter({
    authorization: { mode: 'managed', verifier: trust.verifier },
    bin,
    outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
  })
  try {
    await assert.rejects(
      adapter.startTask(envelope, {
        ...context(root),
        token: trust.issue(envelope),
        beforeSend: async () => { trust.expire() },
      }),
      (err) => err instanceof DispatchPermitError && err.code === 'EXPIRED',
    )
    await assert.rejects(readFile(launches, 'utf8'), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('managed Codex renders the signed envelope snapshot despite caller mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-envelope-snapshot-'))
  const promptFile = join(root, 'prompt.json')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}
const args = process.argv.slice(2)
const prompt = args[args.length - 1]
require('node:fs').writeFileSync(${JSON.stringify(promptFile)}, JSON.stringify({
  original: prompt.includes('SIGNED ORIGINAL'),
  mutated: prompt.includes('UNSIGNED MUTATION')
}))
`)
  await chmod(bin, 0o755)
  const trust = permitTrust('codex-adapter')
  const e = structuredClone(envelope) as TaskEnvelopeV1
  e.goal.statement = 'SIGNED ORIGINAL'
  const adapter = new CodexAdapter({
    authorization: { mode: 'managed', verifier: trust.verifier },
    bin,
    outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
  })
  try {
    const starting = adapter.startTask(e, {
      ...context(root),
      token: trust.issue(e),
      beforeSend: async () => { e.goal.statement = 'SIGNED ORIGINAL' },
    })
    e.goal.statement = 'UNSIGNED MUTATION'
    const binding = await starting
    const deadline = Date.now() + 5000
    while (!(await adapter.getStatus(binding)).terminal_observed) {
      assert.ok(Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.deepEqual(JSON.parse(await readFile(promptFile, 'utf8')), {
      original: true,
      mutated: false,
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex snapshots dispatch context before async startup can be redirected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmap-codex-ctx-snapshot-'))
  const other = await mkdtemp(join(tmpdir(), 'cmap-codex-ctx-other-'))
  const argsFile = join(root, 'args.json')
  const bin = join(root, 'fake-codex.cjs')
  await writeFile(bin, `#!${process.execPath}
const args = process.argv.slice(2)
require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({
  workDir: args[args.indexOf('-C') + 1]
}))
`)
  await chmod(bin, 0o755)
  const adapter = new CodexAdapter({
    authorization: { mode: 'standalone' },
    bin,
    outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
  })
  let originalCalled = false
  let mutatedCalled = false
  const ctx = {
    ...context(root),
    beforeSend: async () => { originalCalled = true },
  }
  try {
    const starting = adapter.startTask(envelope, ctx)
    ;(ctx as { beforeSend: DispatchContext['beforeSend']; worktree: string }).beforeSend = async () => {
      mutatedCalled = true
      throw new Error('redirected callback')
    }
    ;(ctx as { worktree: string }).worktree = other
    const binding = await starting
    const deadline = Date.now() + 5000
    while (!(await adapter.getStatus(binding)).terminal_observed) {
      assert.ok(Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(originalCalled, true)
    assert.equal(mutatedCalled, false)
    assert.equal(JSON.parse(await readFile(argsFile, 'utf8')).workDir, await realpath(root))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

test('Codex authorization mode is snapshotted at construction', () => {
  const authorization = { mode: 'standalone' } as const
  const adapter = new CodexAdapter({
    authorization,
    bin: '/bin/false',
    outputSchemaPath: join(process.cwd(), 'schemas/codex-output.v1.schema.json'),
  })
  ;(authorization as unknown as { mode: 'managed' }).mode = 'managed'
  assert.equal(adapter.authorizationMode, 'standalone')
})

const adapterBinding = (root: string): RemoteTaskBinding => ({
  adapter: 'codex-adapter',
  remote_task_id: 'codex:tsk-idempotence:1',
  protocol: 'codex-exec',
  protocol_version: '0.1.0',
  runner_id: context(root).runner_id,
})

const snapshotEnv = (keys: readonly string[]): Map<string, string | undefined> =>
  new Map(keys.map((key) => [key, process.env[key]]))

const restoreEnv = (snapshot: Map<string, string | undefined>): void => {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
