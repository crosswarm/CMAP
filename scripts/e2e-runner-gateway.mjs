/**
 * runner 出站网关本机两进程模拟（ADR-0008 §3）。不经 Temporal、不调用模型。
 *
 *   TMPDIR=/private/tmp node scripts/e2e-runner-gateway.mjs --simulate [--keep]
 *
 * 进程 1（本脚本）：控制面 API（含 /v1/gateway/*，MemoryStore）+ Worker 侧 GatewayRunnerAdapter 与派发 Activities，
 *   两者共用一个账本，对应生产中共用的 PostgreSQL。
 * 进程 2：真实 runner 守护进程 apps/runner/src/main.ts，出站模式（CMAP_CONTROL_PLANE_URL），假 codex。
 *
 * 场景：
 *   A. runner 领取并完成一个任务：账本 COMPLETED 判定通过，产物哈希由控制面复算，codex 执行 1 次。
 *   B. 执行中 SIGKILL runner 进程（断开）：租约过期后判执行不确定（INPUT_REQUIRED、binding 保留）；
 *      重新拉起 runner 后它领不到这条任务，codex 累计仍只执行 1 次。
 * 判据只认账本状态、租约记录、假 codex 的执行计数与复算的 sha256；不认进程 rc=0、端口 LISTEN。
 */
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'

if (!process.argv.includes('--simulate')) {
  console.error('用法：node scripts/e2e-runner-gateway.mjs --simulate [--keep]（真实两机复测需先完成 M05 注册）')
  process.exit(2)
}
const keep = process.argv.includes('--keep')
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const { MemoryStore, rawEd25519PublicKey } = await import('#domain-model')
const { createControlPlane } = await import('../apps/control-plane-api/src/server.ts')
const { GatewayRunnerAdapter, gatewayLeaseId } = await import('../adapters/runner-gateway/src/index.ts')
const { createActivities } = await import('../workflows/activities.ts')
const { syntheticRunner } = await import('../tests/workflow/fake-adapter.ts')
const { ISSUER, envelope, makeFakeCodex, sha256, signer, trust } = await import('../tests/adapter/remote-runner-fixture.ts')
const { gatewayAuthorization, enrolledRecord, gatewayRunnerRecord, controlPlaneKey } = await import('../tests/adapter/runner-gateway-fixture.ts')

const LEASE_TTL_MS = 3_000
const step = (n, msg) => console.log(`\n[${n}] ${msg}`)
const ok = (msg) => console.log(`  ✓ ${msg}`)
const fail = (msg) => { console.error(`  ✗ ${msg}`); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (check, label, ms = 20_000) => {
  for (const deadline = Date.now() + ms; !(await check()); await sleep(50)) if (Date.now() > deadline) fail(`等待超时：${label}`)
}
const children = new Set()
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL') } catch { /* 已退出 */ } } })

const root = await mkdtemp(join(tmpdir(), 'cmap-e2e-gateway-'))
const cm = join(root, 'crossmini')
await mkdir(cm)
const codex = await makeFakeCodex(root)
const launches = async () => (await readFile(codex.launches, 'utf8').catch(() => '')).split('\n').filter(Boolean).length

step(1, '进程 1：控制面 API（网关）+ Worker 侧网关 Adapter，共用账本')
const store = new MemoryStore()
const api = await createControlPlane({
  store, tenant: 'team-ycc', owner: 'crosswarm',
  runnerGateway: { signingKey: controlPlaneKey.privateKey, leaseTtlMs: LEASE_TTL_MS, pollIntervalMs: 100 },
})
await api.listen(0)
const apiUrl = `http://127.0.0.1:${api.address().port}`
const gateway = new GatewayRunnerAdapter({ authorization: gatewayAuthorization, store, agentId: 'codex@gateway', workRoot: cm, capabilities: ['code.analyze'] })
const acts = createActivities({ store, adapters: [gateway], signDispatchPermit: signer, workRoot: cm, pollIntervalMs: 200,
  runner: syntheticRunner({ runner_id: 'crossmini', agents: ['codex@gateway'] }) })
ok(`API 监听 ${apiUrl}，租约期限 ${LEASE_TTL_MS}ms`)

step(2, '登记 runner 身份（M04：直接写登记记录；M05 起改用注册令牌），写出站模式所需文件')
const runnerKey = generateKeyPairSync('ed25519')
const keyFile = join(root, 'runner', 'runner.key')
await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 })
await writeFile(keyFile, runnerKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
const record = gatewayRunnerRecord('lap-sim', runnerKey.publicKey)
await store.registerGatewayRunner(record)
await writeFile(join(root, 'runner', 'enrollment.json'), JSON.stringify(enrolledRecord(record)), { mode: 0o600 })
const permitPub = join(root, 'permit.pub')
await writeFile(permitPub, trust.publicKey.export({ type: 'spki', format: 'pem' }))
if (rawEd25519PublicKey(runnerKey.publicKey) !== record.public_key) fail('登记公钥不一致')
ok('runner 私钥只在 runner 侧文件里；控制面账本只存公钥')

const startRunner = () => {
  const child = spawn(process.execPath, ['apps/runner/src/main.ts'], {
    cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/private/tmp', NO_PROXY: '127.0.0.1,localhost',
      CMAP_CONTROL_PLANE_URL: apiUrl, CMAP_RUNNER_KEY_FILE: keyFile, CMAP_PERMIT_PUBLIC_KEY_FILE: permitPub,
      CMAP_PERMIT_ISSUER: ISSUER, CMAP_CODEX_MODEL: 'gpt-sim', CODEX_BIN: codex.bin, CMAP_WORK_ROOT: join(root, 'runner', 'work'),
    },
  })
  children.add(child)
  child.on('exit', () => children.delete(child))
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  child.on('exit', (code, sig) => { if (code && !sig) console.error(`  runner 退出 code=${code}\n${err}`) })
  return child
}

step(3, '进程 2：出站模式 runner（不监听端口，主动长轮询）')
let runner = startRunner()
await until(async () => (await store.getGatewayRunner('lap-sim')).last_seen_at !== null, 'runner 首次领取')
ok(`runner pid=${runner.pid} 已通过签名认证领取（last_seen_at 已记）`)

const addTask = async (taskId) => {
  const e = envelope(taskId, { preferred_agent: 'codex@gateway' })
  const now = new Date().toISOString()
  if (!(await store.getMission(e.identity.mission_id))) {
    await store.createMission({ actor: { type: 'system', id: 'e2e' }, mission: {
      id: e.identity.mission_id, tenant: 'team-ycc', owner: 'crosswarm', type: 'inspect', goal: 'gateway sim', constraints: {},
      acceptance: [{ criterion_id: 'C1', metric: 'done', operator: 'eq', expected: true, hard_gate: true }],
      workflow_template: 'dag/v1', state: 'RUNNING', revision: 1, created_at: now, updated_at: now,
    } })
  }
  await store.createTask({ actor: { type: 'system', id: 'e2e' }, task: {
    id: taskId, mission_id: e.identity.mission_id, parent_task_id: null, supersedes_task_id: null, capability: 'code.analyze', risk: 'read-meta',
    state: 'DRAFT', attempt: 1, max_attempts: 1, lamport: 0, envelope: e, result: null, binding: null, deps: [], created_at: now, updated_at: now,
  } })
  await acts.markReady(taskId)
}

step('A', '派发 → runner 领取执行 → 回报落账 → 控制面复算收取')
await addTask('tsk-sim-ok')
const dispatched = await acts.dispatchTask('tsk-sim-ok')
if (!dispatched.dispatched) fail(`派发未受理：${JSON.stringify(dispatched)}`)
const bound = (await store.getTask('tsk-sim-ok')).binding
if (bound.adapter !== 'gateway-runner-adapter' || bound.runner_id !== 'lap-sim') fail(`binding 不对：${JSON.stringify(bound)}`)
ok(`binding ${bound.adapter}@${bound.runner_id}`)
const collected = await acts.collectTaskResult('tsk-sim-ok')
if (!collected.passed) fail(`判定未通过：${JSON.stringify(collected)}`)
const [art] = await store.listArtifacts('tsk-sim-ok')
if (art?.sha256 !== sha256('ok')) fail('产物哈希不符')
const recomputed = sha256(await readFile(join(cm, 'tsk-sim-ok', art.uri)))
if (recomputed !== art.sha256) fail('控制面落盘字节与账本哈希不符')
if ((await launches()) !== 1) fail(`codex 执行次数 ${await launches()}`)
ok(`判定通过；产物 ${art.uri} 控制面复算 sha256=${recomputed.slice(0, 12)}…；codex 执行 1 次；租约 ${(await store.getGatewayLease(gatewayLeaseId(bound))).state}`)

step('B', '执行中断开（SIGKILL runner）→ 租约过期 → 执行不确定，不改派不重跑')
await writeFile(codex.hold, '')
await addTask('tsk-sim-lost')
await acts.dispatchTask('tsk-sim-lost')
await until(async () => (await launches()) === 2, 'codex 第二次启动')
runner.kill('SIGKILL')
await until(async () => runner.exitCode !== null || runner.signalCode !== null, 'runner 退出')
const killedAt = Date.now()
ok(`runner pid=${runner.pid} 已 SIGKILL`)
const lostBinding = (await store.getTask('tsk-sim-lost')).binding
await sleep(LEASE_TTL_MS + 1000)
const uncertain = await acts.collectTaskResult('tsk-sim-lost')
if (!uncertain.executionUncertain) fail(`应判执行不确定：${JSON.stringify(uncertain)}`)
const lostTask = await store.getTask('tsk-sim-lost')
if (lostTask.state !== 'INPUT_REQUIRED' || lostTask.binding?.runner_id !== 'lap-sim') fail(`账本状态不对：${lostTask.state}`)
ok(`断开 ${Date.now() - killedAt}ms 后判 EXECUTION_UNCERTAIN（${uncertain.executionUncertain.code}），任务 INPUT_REQUIRED，binding 保留在 lap-sim`)

runner = startRunner()
await until(async () => Date.parse((await store.getGatewayRunner('lap-sim')).last_seen_at) > killedAt, 'runner 重新上线')
await sleep(1500)
const lease = await store.getGatewayLease(gatewayLeaseId(lostBinding))
if (lease.state !== 'leased' || Date.parse(lease.expires_at) > Date.now()) fail('过期租约被续回或重新入队')
await rm(codex.hold)
await sleep(1000)
if ((await launches()) !== 2) fail(`codex 累计执行 ${await launches()} 次，应为 2（每个任务各 1 次）`)
ok('重新上线的 runner 领不到过期任务；codex 累计执行 2 次（A、B 各 1 次），B 未重跑')

runner.kill('SIGTERM')
await api.close()
if (!keep) await rm(root, { recursive: true, force: true })
console.log('\n全部通过')
process.exit(0)
