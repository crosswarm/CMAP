/**
 * lap runner 守护进程入口（ADR-0006）。部署说明见 docs/remote-runner.md。
 *
 * 只接线：读配置 → 加载固定的 CrossMini 公钥与本机响应签名密钥（首次启动生成，0600）→ 起 HTTP 服务。逻辑在 server.ts，测试与进程跑的是同一套。
 * 停止时只关监听：codex 子进程按运行记录继续或在重启后恢复观察，绝不因守护进程退出而重跑。
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadOrCreatePermitKey, loadPinnedPublicKey } from '#domain-model'
import { createRunnerDaemon, readRunnerDaemonConfig } from './server.ts'

const config = readRunnerDaemonConfig(process.env)
const workRoot = config.workRoot ?? join(dirname(fileURLToPath(import.meta.url)), '../../../.cmap-work')
mkdirSync(dirname(config.signingKeyFile), { recursive: true, mode: 0o700 })
const { server, runner } = await createRunnerDaemon({
  env: process.env,
  publicKey: loadPinnedPublicKey(config.publicKeyFile),
  signingKey: loadOrCreatePermitKey(config.signingKeyFile).privateKey,
  issuer: config.issuer,
  workRoot,
})

const stop = (): void => {
  server.close()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

server.listen(config.port, config.listenHost, () => {
  console.log(`runner 守护进程就绪：runner=${runner.runner_id} listen=${config.listenHost}:${config.port} 工作区=${workRoot}`)
})
