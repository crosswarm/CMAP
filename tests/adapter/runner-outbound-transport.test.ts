/**
 * 出站客户端传输（2026-10-23 生产缺陷）：Node 26 自带的 undici 8 对 https 默认协商 HTTP/2，
 * 长轮询 claim 在途时同一连接上的带体 POST 被排到 claim 返回之后才发出，签名早已过 ±2 秒窗口被 401。
 * 这里用本地 HTTPS 服务器（ALPN 同时提供 h2 与 http/1.1，与边缘一致）挂起 claim，断言期间的回报立即到达且签名仍在窗口内。
 */
// precommit-allow-secrets: 仅供本测试回环 HTTPS 服务器使用的自签名 localhost 证书与私钥，不对应任何真实服务
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createSecureServer } from 'node:http2'
import type { AddressInfo, Socket } from 'node:net'
import tls from 'node:tls'

import { signRunnerResponse, verifyRunnerRequest } from '../../packages/domain-model/src/dispatch-permit.ts'
import { gatewayCall } from '../../apps/runner/src/outbound.ts'

const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg542608sntx39V/2z
7zT6uGvf+3wEzb4+en5CZjHtF8qhRANCAAQH+zF4CjlGDmdbr7H3/bt5qpga7qbM
SuZGkoEcUf0/H1sw5I020++ztlBqT3V3MD3O1om4rOpxw62KUn1N0TPp
-----END PRIVATE KEY-----`
const CERT = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUGgAwIBAgIUBP3CH7YDpqbhX2oL0aZ9o8kjW/swCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyMzA2NDkyNVoYDzIxMjYwOTI5
MDY0OTI1WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQH+zF4CjlGDmdbr7H3/bt5qpga7qbMSuZGkoEcUf0/H1sw5I020++z
tlBqT3V3MD3O1om4rOpxw62KUn1N0TPpo28wbTAdBgNVHQ4EFgQUtUkOb66yOxmO
U80eknxjzsLC2qYwHwYDVR0jBBgwFoAUtUkOb66yOxmOU80eknxjzsLC2qYwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSQAwRgIhANoPkEtMohZ/pWZEGMbzuCVaeQw2FQej9Iz5TSxH0u8XAiEA
pn4sJ6YRkCaYHTntpf2TDBwlKCODufooPoJyCsS5UVc=
-----END CERTIFICATE-----`

const SCHEMA = 'cmap/runner-gateway/v1'
const LEASE = `lse_${'0'.repeat(40)}`
const CLAIM_HOLD_MS = 3_000

test('长轮询 claim 在途时，回报立即发出（1 秒内到达）且签名时间戳仍在 ±2 秒窗口内', async () => {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), CERT])
  const runnerKey = generateKeyPairSync('ed25519')
  const controlPlaneKey = generateKeyPairSync('ed25519')
  const runnerId = 'rnr_transport'
  const arrivals: { path: string; at: number; authOk: boolean; httpVersion: string }[] = []

  const server = createSecureServer({ key: KEY, cert: CERT, allowHTTP1: true }, (req, res) => {
    const at = Date.now()
    const path = req.url
    let authOk = true
    let nonce = ''
    try {
      nonce = verifyRunnerRequest({ publicKey: runnerKey.publicKey, method: 'POST', target: path, audience: runnerId, headers: req.headers, nowMs: at, scheme: 'gateway' }).nonce
    } catch {
      authOk = false
    }
    arrivals.push({ path, at, authOk, httpVersion: req.httpVersion })
    req.resume()
    req.on('end', () => {
      const reply = (message: object): void => {
        const body = JSON.stringify(message)
        const signature = signRunnerResponse({ privateKey: controlPlaneKey.privateKey, audience: runnerId, requestNonce: nonce, status: 200, body, scheme: 'gateway' })
        res.writeHead(200, { 'content-type': 'application/json', 'x-cmap-signature': signature })
        res.end(body)
      }
      if (!authOk) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ schema: SCHEMA, kind: 'error', code: 'UNAUTHORIZED', retryable: false }))
      } else if (path === '/v1/gateway/claim') {
        setTimeout(() => reply({ schema: SCHEMA, kind: 'claim_result', runner_id: runnerId, renewed: [], expired: [], assignment: null, cancels: [] }), CLAIM_HOLD_MS)
      } else {
        reply({ schema: SCHEMA, kind: 'report_ack', lease_id: LEASE, lease: null })
      }
    })
  })
  const sockets = new Set<Socket>()
  server.on('secureConnection', (socket: Socket) => { sockets.add(socket) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const client = {
    controlPlaneUrl: `https://localhost:${(server.address() as AddressInfo).port}`,
    signingKey: runnerKey.privateKey, controlPlanePublicKey: controlPlaneKey.publicKey, runnerId,
  }
  try {
    const claim = gatewayCall(client, '/v1/gateway/claim', { schema: SCHEMA, kind: 'claim', runner_id: runnerId, wait_seconds: 3, held_leases: [] }, 10_000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const sentAt = Date.now()
    const report = gatewayCall(client, '/v1/gateway/reports', {
      schema: SCHEMA, kind: 'report', runner_id: runnerId, lease_id: LEASE,
      body: { schema: 'cmap/remote-runner/v1', kind: 'status', remote_task_id: 'codex:tsk-transport:1', status: 'running', terminal_observed: false },
    }, 10_000).catch((error: unknown) => error)
    const [claimed, reported] = await Promise.all([claim, report])
    const arrived = arrivals.find((a) => a.path === '/v1/gateway/reports')
    assert.ok(arrived, '回报没有到达服务器')
    assert.ok(arrived.at - sentAt < 1_000, `回报被排队 ${arrived.at - sentAt}ms 才到达（HTTP ${arrived.httpVersion}）`)
    assert.equal(arrived.authOk, true, '回报到达时签名时间戳已超出窗口')
    assert.deepEqual(reported, { status: 200, message: { schema: SCHEMA, kind: 'report_ack', lease_id: LEASE, lease: null } })
    assert.equal(claimed.message.kind, 'claim_result')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})
