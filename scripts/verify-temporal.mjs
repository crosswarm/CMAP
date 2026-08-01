/**
 * 验证 Temporal 是否真的可用。
 *
 * 判据不是「端口能连」，而是「SDK 能建连并拿到集群信息」——这才是
 * Worker 与 Client 实际走的路径。容器 Up ≠ 服务就绪，端口 LISTEN 也
 * 不等于 gRPC 握手成功。
 *
 * 用法：node scripts/verify-temporal.mjs
 */
import { Connection, Client } from '@temporalio/client'

// 本机 http_proxy 指向 Surge，若不排除 localhost，gRPC 可能被代理拦截，
// 表现为连接看似建立却永远等不到响应（静默挂起）。
process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1'
process.env['no_proxy'] = 'localhost,127.0.0.1,::1'
process.env['grpc_proxy'] = ''

const address = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default'

const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

let connection
try {
  // 显式超时：宁可明确失败，也不要静默挂起
  connection = await Connection.connect({
    address,
    connectTimeout: 15_000,
  })
} catch (e) {
  fail(`无法建立 gRPC 连接 ${address}：${e?.message ?? e}`)
}

console.log(`✓ gRPC 连接建立 ${address}`)

try {
  const info = await connection.workflowService.getSystemInfo({})
  console.log(`✓ 服务端版本 ${info.serverVersion}`)
} catch (e) {
  fail(`getSystemInfo 失败：${e?.message ?? e}`)
}

try {
  const res = await connection.workflowService.listNamespaces({ pageSize: 20 })
  const names = (res.namespaces ?? []).map((n) => n.namespaceInfo?.name).filter(Boolean)
  console.log(`✓ namespace 列表：${names.join(', ')}`)

  if (!names.includes(namespace)) {
    // auto-setup.sh 的就绪等待循环去连 127.0.0.1:8234（server 实际绑定
    // 容器 IP 的 7233，且无 8234 监听），永远等不到，于是它后面的
    // 「创建 default namespace」一步从未执行。这里补上，幂等。
    console.log(`  namespace「${namespace}」缺失，正在创建（auto-setup 未完成该步）…`)
    try {
      await connection.workflowService.registerNamespace({
        namespace,
        workflowExecutionRetentionPeriod: { seconds: 60 * 60 * 24 * 3 },
      })
    } catch (e) {
      // 并发或重复执行时会报已存在，属正常
      if (!/already exists/i.test(String(e?.message ?? e))) throw e
    }

    // 写入即校验：不信返回值，回读确认真的建成了
    const after = await connection.workflowService.listNamespaces({ pageSize: 20 })
    const afterNames = (after.namespaces ?? []).map((n) => n.namespaceInfo?.name).filter(Boolean)
    if (!afterNames.includes(namespace)) {
      fail(`创建后回读仍未见 namespace「${namespace}」`)
    }
    console.log(`✓ namespace「${namespace}」已创建并回读确认`)
  } else {
    console.log(`✓ 目标 namespace「${namespace}」可用`)
  }
} catch (e) {
  fail(`namespace 处理失败：${e?.message ?? e}`)
}

// Client 能构造并发出一次真实调用，才算端到端可用
try {
  const client = new Client({ connection, namespace })
  const iter = client.workflow.list({ pageSize: 1 })
  await iter[Symbol.asyncIterator]().next()
  console.log('✓ Client 可发起 workflow 查询')
} catch (e) {
  fail(`Client 查询失败：${e?.message ?? e}`)
}

await connection.close()
console.log('\nTemporal 端到端可用。')
