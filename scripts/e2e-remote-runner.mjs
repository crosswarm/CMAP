/**
 * 远程 runner 真实链路验证（ADR-0006）。不经 Temporal，直接用 RemoteRunnerAdapter 走 HTTP 薄协议。
 *
 *   node scripts/e2e-remote-runner.mjs --simulate [--fake-codex] [--keep]
 *       本机双端口模拟：拉起两个真实守护进程（apps/runner/src/main.ts）——lap-sim 与 lap-sim-2，
 *       各自监听 127.0.0.1 的空闲端口；临时生成控制面签名密钥（0600）并让守护进程固定其公钥。
 *       默认用真实 codex（经计数包装器；需 CMAP_CODEX_MODEL，建议 TMPDIR=/private/tmp）；
 *       --fake-codex 用确定性假 codex，不调用模型。
 *   node scripts/e2e-remote-runner.mjs
 *       Stage 4 骨架：对真实 lap 运行同样的派发与判据。需要
 *       CMAP_REMOTE_RUNNER_URL、CMAP_REMOTE_RUNNER_ID、CMAP_PERMIT_KEY_FILE（CrossMini 的签名密钥）。
 *       codex 执行次数只能在 lap 上核对（<CMAP_WORK_ROOT>/.runs/<task>.json），脚本不远程登录 lap。
 *
 * 判据只认：健康探测的协议响应、结果终态、CrossMini 侧独立复算的产物哈希、codex exec 计数、
 * 同一许可投到另一 runner 时的 CLAIM_MISMATCH。不认进程 rc=0、端口 LISTEN。
 * 不打印许可、密钥或提示词正文。
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

const { issueDispatchPermit, verifyDispatchPermit, loadOrCreatePermitKey, DispatchPermitError } = await import('#domain-model')
const { RemoteRunnerAdapter, REMOTE_ADAPTER_ID } = await import('../adapters/remote-runner/src/index.ts')
const { CODEX_CAPABILITIES } = await import('../adapters/codex-adapter/src/index.ts')

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const simulate = process.argv.includes('--simulate')
const fakeCodex = process.argv.includes('--fake-codex')
const keep = process.argv.includes('--keep')
const ISSUER = 'cmap:local-control-plane'

const step = (n, msg) => console.log(`\n[${n}] ${msg}`)
const ok = (msg) => console.log(`  ✓ ${msg}`)
const children = []
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  process.exit(1)
}
process.on('exit', () => { for (const c of children) { try { c.kill('SIGTERM') } catch { /* 已退出 */ } } })

const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const countLines = async (p) => (await readFile(p, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

const root = await mkdtemp(join(tmpdir(), 'cmap-e2e-remote-'))
const crossmini = join(root, 'crossmini')
await mkdir(crossmini)

// ------------------------------------------------------------ 1. 信任与目标

step(1, simulate ? '本机双端口模拟：生成控制面密钥，拉起两个守护进程' : '真实 lap：读取 CrossMini 签名密钥与目标地址')

let keyFile, runnerId, lapUrl, replayUrl, replayRunnerId, launchesFile = null, otherLaunches = null
if (simulate) {
  keyFile = join(root, 'permit.key')
  const { publicKey } = loadOrCreatePermitKey(keyFile)
  const pubFile = join(root, 'control-plane.pub')
  await writeFile(pubFile, publicKey.export({ type: 'spki', format: 'pem' }))
  ok('签名密钥 0600 已生成；守护进程只拿到公钥文件')

  const makeBin = async (name) => {
    const bin = join(root, `${name}-codex`)
    const launches = join(root, `${name}-launches`)
    if (fakeCodex) {
      await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
if (process.argv.includes('--version')) { console.log('fake-codex 0.0.0'); process.exit(0) }
const a = process.argv.slice(2)
if (a[0] !== 'exec') process.exit(0)
fs.appendFileSync(${JSON.stringify(launches)}, process.pid + '\\n')
const wd = a[a.indexOf('-C') + 1], out = a[a.indexOf('-o') + 1]
fs.mkdirSync(path.join(wd, 'evidence'), { recursive: true })
fs.writeFileSync(path.join(wd, 'evidence/hello.txt'), 'hello\\n')
fs.writeFileSync(out, JSON.stringify({ status: 'completed', summary: 'wrote hello',
  criterion_results: [{ criterion_id: 'LINES', actual: '1', passed: true, evidence_artifact_ids: ['hello'] }],
  artifacts: [{ artifact_id: 'hello', role: 'hello_report', uri: 'evidence/hello.txt', media_type: 'text/plain', size_bytes: 6, sha256: ${JSON.stringify(sha256('hello\n'))} }],
  findings: [], error: null }))
`)
    } else {
      const real = process.env['CODEX_BIN'] ?? 'codex'
      // 只给 exec 计数：健康探测的 --version 不是一次执行
      await writeFile(bin, `#!/bin/sh\n[ "$1" = exec ] && echo $$ >> '${launches}'\nexec ${JSON.stringify(real)} "$@"\n`)
    }
    await chmod(bin, 0o755)
    return { bin, launches }
  }
  const model = process.env['CMAP_CODEX_MODEL'] ?? (fakeCodex ? 'fake-model' : '')
  if (!model) fail('真实 codex 模式需要 CMAP_CODEX_MODEL（lap 上同样必须显式配置）')

  const startDaemon = async (id) => {
    const port = await freePort()
    const { bin, launches } = await makeBin(id)
    const env = { ...process.env }
    for (const k of ['CMAP_DATABASE_URL', 'MEMROSS_URL', 'MEMROSS_TOKEN', 'CMAP_PERMIT_KEY_FILE', 'TEMPORAL_ADDRESS']) delete env[k]
    const child = spawn(process.execPath, ['apps/runner/src/main.ts'], {
      cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...env,
        RUNNER_ID: id, RUNNER_TENANT: 'team-ycc', RUNNER_HOST: id, RUNNER_ALLOWED_TENANTS: 'team-ycc',
        RUNNER_ALLOWED_OWNERS: 'crosswarm', RUNNER_ALLOWED_CAPABILITIES: 'code.analyze', RUNNER_MAX_RISK: 'read-meta',
        CMAP_RUNNER_LISTEN_HOST: '127.0.0.1', CMAP_RUNNER_PORT: String(port),
        CMAP_PERMIT_PUBLIC_KEY_FILE: pubFile, CMAP_CODEX_MODEL: model, CODEX_BIN: bin, CMAP_WORK_ROOT: join(root, id),
      },
    })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c })
    children.push(child)
    child.on('exit', (code) => { if (code) console.error(`  守护进程 ${id} 退出 ${code}：${stderr.slice(-500)}`) })
    return { url: `http://127.0.0.1:${port}`, launches }
  }
  runnerId = 'lap-sim'
  const a = await startDaemon(runnerId)
  const b = await startDaemon('lap-sim-2')
  lapUrl = a.url
  launchesFile = a.launches
  replayUrl = b.url
  replayRunnerId = runnerId // 受众是 lap-sim 的许可，被投到 lap-sim-2
  ok(`lap-sim → ${a.url}，lap-sim-2 → ${b.url}（${fakeCodex ? '假 codex' : '真实 codex'}，模型经 -m 显式传入）`)
  otherLaunches = b.launches
} else {
  keyFile = process.env['CMAP_PERMIT_KEY_FILE']
  runnerId = process.env['CMAP_REMOTE_RUNNER_ID']
  lapUrl = process.env['CMAP_REMOTE_RUNNER_URL']
  if (!keyFile || !runnerId || !lapUrl) fail('需要 CMAP_PERMIT_KEY_FILE、CMAP_REMOTE_RUNNER_ID、CMAP_REMOTE_RUNNER_URL')
  replayUrl = lapUrl
  replayRunnerId = `${runnerId}-replay` // 受众是别的 runner 的许可，被投到 lap
  ok(`目标 ${runnerId} @ ${lapUrl}`)
}

const { privateKey, publicKey } = loadOrCreatePermitKey(keyFile)
const authorizationFor = (id) => ({ mode: 'managed', verifier: (token, envelope, adapterId, ctxRunner) => {
  if (ctxRunner !== id) throw new DispatchPermitError('CLAIM_MISMATCH')
  return verifyDispatchPermit(token, { publicKey, issuer: ISSUER, runnerId: id, adapterId, envelope })
} })
const adapterFor = (id, url) => new RemoteRunnerAdapter({
  authorization: authorizationFor(id), baseUrl: url, runnerId: id, agentId: `codex@${id}`,
  workRoot: crossmini, capabilities: CODEX_CAPABILITIES,
})
const adapter = adapterFor(runnerId, lapUrl)

// ------------------------------------------------------------ 2. 健康探测

step(2, '3 秒健康探测（协议响应 + runner_id 一致 + 远端 codex --version 成功）')
let health
for (let i = 0; i < 50; i += 1) {
  health = await adapter.health()
  if (health.state === 'healthy') break
  await sleep(200)
}
if (health.state !== 'healthy') fail(`远程 runner 不健康：${health.detail ?? health.state}`)
ok('healthy')

// ------------------------------------------------------------ 3. 派发

const TASK_ID = `tsk-e2e-remote-${Date.now().toString(36)}`
const envelope = {
  schema: 'cmap/task-envelope/v1',
  identity: { mission_id: 'mis-e2e-remote', task_id: TASK_ID, idempotency_key: `mis-e2e-remote:${TASK_ID}`, revision: 1, tenant: 'team-ycc', owner: 'crosswarm' },
  classification: { task_type: 'inspect.hello', requested_capability: 'code.analyze', risk_level: 'read-meta' },
  goal: {
    statement: '在当前工作目录创建文件 evidence/hello.txt，内容只有一行 hello；把它作为 role=hello_report 的证据产物报告，并报告该文件的行数。',
    success_definition: [{ criterion_id: 'LINES', metric: 'hello_line_count', operator: 'eq', expected: 1, hard_gate: true }],
  },
  environment: {},
  execution_policy: { timeout_seconds: 600, max_attempts: 1 },
  permissions: { forbidden: ['production_access', 'network_write'] },
  evidence_requirements: { required_artifact_roles: ['hello_report'] },
  output_contract: { schema_uri: 'https://cmap.local/schemas/task-result/v1' },
}
const ctxFor = async (id, token) => {
  const worktree = join(crossmini, TASK_ID)
  await mkdir(worktree, { recursive: true })
  return { token, runner_id: id, trace_id: TASK_ID, correlation_id: envelope.identity.idempotency_key, worktree,
    deadline_at: new Date(Date.now() + 600_000).toISOString(), beforeSend: async () => {} }
}

step(3, '签发受众为目标 runner 的许可并派发；立即重放到同一 runner 与另一 runner')
const token = issueDispatchPermit({ privateKey, issuer: ISSUER, runnerId, adapterId: REMOTE_ADAPTER_ID, envelope })
const binding = await adapter.startTask(envelope, await ctxFor(runnerId, token))
ok(`已受理：${binding.remote_task_id} @ ${binding.runner_id}`)
const again = await adapter.startTask(envelope, await ctxFor(runnerId, token))
if (again.remote_task_id !== binding.remote_task_id) fail('同 runner 重放返回了不同的 remote_task_id')
ok('同 runner 重放复用既有 binding')

const replayToken = replayRunnerId === runnerId ? token
  : issueDispatchPermit({ privateKey, issuer: ISSUER, runnerId: replayRunnerId, adapterId: REMOTE_ADAPTER_ID, envelope })
try {
  await adapterFor(replayRunnerId, replayUrl).startTask(envelope, await ctxFor(replayRunnerId, replayToken))
  fail('另一 runner 接受了不属于它的许可')
} catch (error) {
  if (!(error instanceof DispatchPermitError) || error.code !== 'CLAIM_MISMATCH') fail(`预期 CLAIM_MISMATCH，实际 ${error?.code ?? error}`)
}
ok('许可投到另一 runner → CLAIM_MISMATCH')

// ------------------------------------------------------------ 4. 等终态并拉取结果

step(4, '轮询终态，拉取结果与产物，CrossMini 独立复算哈希')
const started = Date.now()
for (;;) {
  const status = await adapter.getStatus(binding)
  if (status.terminal_observed) { ok(`终态 ${status.status}（${Math.round((Date.now() - started) / 1000)}s）`); break }
  if (Date.now() - started > 600_000) fail('等待终态超时')
  await sleep(2_000)
}
const result = await adapter.collectResult(binding)
if (result.status !== 'completed') fail(`结果状态 ${result.status}：${result.error?.code ?? ''}`)
if (!result.artifacts.length) fail('没有产物')
for (const art of result.artifacts) {
  const bytes = await readFile(join(crossmini, TASK_ID, art.uri))
  if (sha256(bytes) !== art.sha256) fail(`产物 ${art.role} 哈希与 CrossMini 落盘字节不符`)
  ok(`产物 ${art.role}（${bytes.length} B）已落在 CrossMini，sha256 复算一致`)
}
const criterion = result.criterion_results.find((c) => c.criterion_id === 'LINES')
ok(`LINES actual=${JSON.stringify(criterion?.actual)}`)

// ------------------------------------------------------------ 5. 执行次数

step(5, 'codex exec 执行次数')
if (launchesFile) {
  const n = await countLines(launchesFile)
  const m = await countLines(otherLaunches)
  if (n !== 1 || m !== 0) fail(`执行次数异常：lap-sim=${n} lap-sim-2=${m}`)
  ok('lap-sim 执行 1 次，lap-sim-2 执行 0 次')
} else {
  ok(`请在 lap 上核对 <CMAP_WORK_ROOT>/.runs/${TASK_ID}.json 只有一条运行记录`)
}

if (!keep) await rm(root, { recursive: true, force: true })
console.log('\n远程 runner 链路验证通过')
process.exit(0)
