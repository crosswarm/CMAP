/**
 * 备份本地栈的 PostgreSQL 库（cmap 账本 + temporal 工作流状态）。
 *
 * 经 `docker exec cmap-postgres pg_dump` 导出自定义格式（-Fc，可用 pg_restore 还原），
 * 宿主无需安装 PG 客户端；容器内走本地 socket，不需要也不记录密码。
 * 备份含任务账本与业务数据，默认写到仓库外的 ~/.cmap/backups（目录 0700、文件 0600）。
 *
 * 环境变量：
 *   CMAP_BACKUP_DIR   输出目录，默认 ~/.cmap/backups
 *   CMAP_BACKUP_KEEP  每个库保留最近几份，默认 14
 *
 * 任一库备份失败则非零退出，且不删除旧备份。还原步骤见 infra/docker-compose/README.md。
 * 用法：node scripts/backup-db.mjs
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'

const CONTAINER = 'cmap-postgres'
const PG_USER = 'temporal'
const DATABASES = ['cmap', 'temporal']

/** 文件名里的 UTC 时间戳可按字典序排序；返回该库超出保留份数的旧备份。 */
export function expiredBackups(names, database, keep) {
  const own = names.filter(name => name.startsWith(`${database}-`) && name.endsWith('.dump'))
  return own.sort().reverse().slice(keep)
}

async function dump(database, file) {
  const partial = `${file}.partial`
  const child = spawn('docker', ['exec', CONTAINER, 'pg_dump', '-U', PG_USER, '-Fc', database], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  try {
    await pipeline(child.stdout, createWriteStream(partial, { mode: 0o600 }))
    const code = await exited
    if (code !== 0) throw new Error(`pg_dump ${database} 退出码 ${code}`)
    if ((await stat(partial)).size === 0) throw new Error(`pg_dump ${database} 输出为空`)
    await rename(partial, file)
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
}

async function main() {
  const dir = process.env['CMAP_BACKUP_DIR'] ?? join(homedir(), '.cmap', 'backups')
  const keep = Number(process.env['CMAP_BACKUP_KEEP'] ?? 14)
  if (!Number.isInteger(keep) || keep < 1) throw new Error('CMAP_BACKUP_KEEP 必须是正整数')

  await mkdir(dir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(/[-:]/g, '')
  let failed = false
  for (const database of DATABASES) {
    const file = join(dir, `${database}-${stamp}.dump`)
    try {
      await dump(database, file)
      console.log(`${database}: ${file} (${(await stat(file)).size} bytes)`)
      for (const old of expiredBackups(await readdir(dir), database, keep)) await rm(join(dir, old))
    } catch (error) {
      failed = true
      console.error(`${database}: 备份失败：${error.message}`)
    }
  }
  if (failed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
