/**
 * runner 守护进程入口。部署说明见 docs/remote-runner.md。
 *
 * 两种模式：
 *  - 监听模式（ADR-0006）：CrossMini 经 Tailscale 拨入本机 HTTP 端口。
 *  - 出站模式（ADR-0008 §3）：设置 CMAP_CONTROL_PLANE_URL 后不监听任何端口，主动长轮询控制面网关领取任务。
 *
 * 只接线：读配置 → 加载固定公钥与本机签名密钥（首次启动生成，0600）→ 起服务或出站循环。逻辑在 server.ts / outbound.ts，测试与进程跑的是同一套。
 * 停止时只关监听或退出循环：codex 子进程按运行记录继续或在重启后恢复观察，绝不因守护进程退出而重跑。
 */
import { mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ed25519PublicKeyFromRaw, loadOrCreatePermitKey, loadPinnedPublicKey } from '#domain-model'
import { GATEWAY_ADAPTER_ID } from '../../../adapters/runner-gateway/src/index.ts'
import { cachedQuotaProbe, probeCodexQuota } from '../../../packages/adapter-sdk/src/quota-probe.ts'
import { createRunnerCore, createRunnerDaemon, readRunnerDaemonConfig } from './server.ts'
import { enrolledRunnerEnv, loadOrEnroll, readOutboundRunnerConfig, startOutboundRunner } from './outbound.ts'

const defaultWorkRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../.cmap-work')
const stopping = new AbortController()

if (process.env['CMAP_CONTROL_PLANE_URL']?.trim()) {
  const config = readOutboundRunnerConfig(process.env)
  const workRoot = config.workRoot ?? defaultWorkRoot
  mkdirSync(dirname(config.signingKeyFile), { recursive: true, mode: 0o700 })
  const { privateKey } = loadOrCreatePermitKey(config.signingKeyFile)
  const enrolled = await loadOrEnroll({
    controlPlaneUrl: config.controlPlaneUrl, enrollmentFile: config.enrollmentFile, privateKey,
    host: process.env['RUNNER_HOST']?.trim() || hostname(), token: process.env['CMAP_RUNNER_ENROLL_TOKEN'],
  })
  const core = await createRunnerCore({
    env: enrolledRunnerEnv(process.env, enrolled), publicKey: loadPinnedPublicKey(config.publicKeyFile),
    issuer: config.issuer, workRoot, permitAdapterId: GATEWAY_ADAPTER_ID,
  })
  const outbound = startOutboundRunner({
    core, controlPlaneUrl: config.controlPlaneUrl, signingKey: privateKey,
    controlPlanePublicKey: ed25519PublicKeyFromRaw(enrolled.control_plane_public_key), signal: stopping.signal,
  })
  process.on('SIGINT', () => stopping.abort())
  process.on('SIGTERM', () => stopping.abort())
  console.log(`runner 守护进程就绪（出站）：runner=${enrolled.runner_id} owner=${enrolled.owner} 控制面=${config.controlPlaneUrl} 工作区=${workRoot}`)
  await outbound.done
} else {
  const config = readRunnerDaemonConfig(process.env)
  const workRoot = config.workRoot ?? defaultWorkRoot
  mkdirSync(dirname(config.signingKeyFile), { recursive: true, mode: 0o700 })
  const { server, runner } = await createRunnerDaemon({
    env: process.env,
    publicKey: loadPinnedPublicKey(config.publicKeyFile),
    signingKey: loadOrCreatePermitKey(config.signingKeyFile).privateKey,
    issuer: config.issuer,
    workRoot,
    // 额度快照（ADR-0009）：5 分钟缓存；health 最多等 1.5 秒，留在控制面 3 秒健康超时之内，等不到先报旧值或 unknown
    quota: cachedQuotaProbe('codex', () => probeCodexQuota(), { waitMs: 1_500 }),
  })
  const stop = (): void => {
    server.close()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  server.listen(config.port, config.listenHost, () => {
    console.log(`runner 守护进程就绪：runner=${runner.runner_id} listen=${config.listenHost}:${config.port} 工作区=${workRoot}`)
  })
}
