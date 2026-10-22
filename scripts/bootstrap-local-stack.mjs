/**
 * 本地栈一条命令初始化（可重复执行）。
 *
 * compose 用 `command: ["start"]` 跳过了 autosetup，全新数据卷上 Temporal 会因
 * schema 不存在而重启循环；CMAP 账本库 `cmap` 也不会自动创建。本脚本把 README
 * 「新环境初始化」的手工步骤固化：每一步先检查，已就绪则跳过。
 *
 * 判据仍以 scripts/verify-temporal.mjs 为准（SDK 建连），不看容器 Up 或端口。
 *
 * 用法：node scripts/bootstrap-local-stack.mjs
 */
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const compose = ['compose', '-f', 'infra/docker-compose/docker-compose.yml']
const psql = (database, sql) =>
  run('docker', ['exec', 'cmap-postgres', 'psql', '-U', 'temporal', '-d', database, '-tAc', sql]).then(r => r.stdout.trim())
const step = (msg) => console.log(`\n▸ ${msg}`)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

step('启动 PostgreSQL 并等待健康')
await run('docker', [...compose, 'up', '-d', 'postgresql'])
for (let i = 0; ; i += 1) {
  const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'cmap-postgres'])
  if (stdout.trim() === 'healthy') break
  if (i > 60) throw new Error('cmap-postgres 60 秒内未就绪')
  await sleep(1000)
}

step('检查 Temporal schema')
const hasSchema = await psql('temporal', "select 1 from information_schema.tables where table_name = 'schema_version' limit 1").catch(() => '')
if (hasSchema === '1') {
  console.log('  已存在，跳过')
} else {
  console.log('  不存在：用一次性 autosetup 容器建 schema 与 default namespace（代理变量必须清空）')
  await run('docker', [...compose, 'stop', 'temporal', 'temporal-ui']).catch(() => {})
  const network = (await run('docker', ['network', 'ls', '--format', '{{.Name}}'])).stdout.split('\n').find(name => /^cmap-dev_default$/.test(name))
  if (!network) throw new Error('找不到 compose 网络 cmap-dev_default')
  await run('docker', ['rm', '-f', 'cmap-temporal-setup']).catch(() => {})
  await run('docker', ['run', '-d', '--name', 'cmap-temporal-setup', '--network', network,
    '-e', 'DB=postgres12', '-e', 'DB_PORT=5432', '-e', 'POSTGRES_USER=temporal', '-e', 'POSTGRES_PWD=temporal', '-e', 'POSTGRES_SEEDS=postgresql',
    '-e', 'HTTP_PROXY=', '-e', 'HTTPS_PROXY=', '-e', 'http_proxy=', '-e', 'https_proxy=', '-e', 'NO_PROXY=*',
    `temporalio/auto-setup:${process.env['TEMPORAL_VERSION'] ?? '1.29.3'}`, 'autosetup'])
  try {
    for (let i = 0; ; i += 1) {
      const { stdout } = await run('docker', ['logs', 'cmap-temporal-setup'], { maxBuffer: 64 * 1024 * 1024 })
      if (stdout.includes('Default namespace default registration complete')) break
      if (i > 120) throw new Error('autosetup 240 秒内未完成，查看 docker logs cmap-temporal-setup')
      await sleep(2000)
    }
  } finally {
    await run('docker', ['rm', '-f', 'cmap-temporal-setup']).catch(() => {})
  }
  console.log('  schema 与 default namespace 已建好')
}

step('检查 CMAP 账本库 cmap')
if ((await psql('postgres', "select 1 from pg_database where datname = 'cmap'")) === '1') {
  console.log('  已存在，跳过')
} else {
  await run('docker', ['exec', 'cmap-postgres', 'createdb', '-U', 'temporal', 'cmap'])
  console.log('  已创建')
}

step('启动完整栈并以 SDK 建连判定就绪')
await run('docker', [...compose, 'up', '-d'])
for (let i = 0; ; i += 1) {
  const verify = spawnSync(process.execPath, ['scripts/verify-temporal.mjs'], { encoding: 'utf8' })
  if (verify.status === 0) {
    console.log(verify.stdout.trim())
    break
  }
  if (i > 20) throw new Error(`Temporal 未就绪：\n${verify.stderr || verify.stdout}`)
  await sleep(5000)
}
console.log('\n✅ 本地栈就绪')
