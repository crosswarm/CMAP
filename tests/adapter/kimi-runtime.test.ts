import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { once } from 'node:events'
import { promisify } from 'node:util'
import {
  buildKimiSandbox,
  assertNoProjectMcp,
  controlPlanePorts,
} from '../../adapters/kimi-adapter/src/runtime.ts'

const exec = promisify(execFile)

test(
  'Kimi 外层沙箱禁止连接控制面本机端口，其他本机端口照常',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const listen = async (): Promise<[Server, number]> => {
      const server = createServer((s) => s.end())
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      return [server, (server.address() as { port: number }).port]
    }
    const [denied, deniedPort] = await listen()
    const [allowed, allowedPort] = await listen()
    t.after(() => { denied.close(); allowed.close() })
    const root = await mkdtemp('/private/tmp/cmap-kimi-net-')
    t.after(() => rm(root, { recursive: true, force: true }))
    const profile = buildKimiSandbox({
      workDir: root, runtimeDir: root, credentialDir: root, oauthDir: root,
      userHome: root + '/home', bin: await realpath(process.execPath),
    }, [deniedPort])
    const code = `const net=require('node:net');const probe=p=>new Promise(r=>{const s=net.connect(p,'127.0.0.1');s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false))});Promise.all([probe(${deniedPort}),probe(${allowedPort})]).then(([d,a])=>console.log(JSON.stringify({denied:d,allowed:a})))`
    const { stdout } = await exec('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', code])
    assert.deepEqual(JSON.parse(stdout), { denied: false, allowed: true })
  },
)

test('控制面端口取自 API、账本库与 Temporal 配置', () => {
  assert.deepEqual(controlPlanePorts({}), [8787, 5433, 7233, 8088])
  assert.deepEqual(controlPlanePorts({
    CMAP_API_PORT: '9000',
    CMAP_DATABASE_URL: 'postgres://u:p@localhost:6000/cmap',
    TEMPORAL_ADDRESS: 'localhost:7300',
  }), [9000, 6000, 7300, 8088])
})
test(
  'Kimi 外层沙箱保护目录并禁止创建 MCP 配置',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await mkdtemp('/private/tmp/cmap-kimi-boundary-')
    t.after(() => rm(root, { recursive: true, force: true }))
    const paths = {
      workDir: root + '/work',
      runtimeDir: root + '/runtime',
      credentialDir: root + '/home/credentials',
      oauthDir: root + '/home/oauth',
      userHome: root + '/home',
      bin: process.execPath,
    }
    for (const p of Object.values(paths).filter((p) => p !== process.execPath))
      await mkdir(p, { recursive: true })
    await writeFile(root + '/home/private.txt', 'synthetic-private')
    const profile = buildKimiSandbox({
      ...paths,
      bin: await realpath(process.execPath),
    }, controlPlanePorts({}))
    const code = `const fs=require('node:fs');let r={};for(const [key,p] of Object.entries(${JSON.stringify({ work: root + '/work/ok', outside: root + '/outside', auth: root + '/home/credentials/rotated' })})){try{fs.writeFileSync(p,'synthetic');r[key]=true}catch{r[key]=false}}try{fs.readFileSync(${JSON.stringify(root + '/home/private.txt')});r.privateRead=true}catch{r.privateRead=false}try{fs.writeFileSync(${JSON.stringify(root + '/work/.mcp.json')},'{}');r.mcpWrite=true}catch{r.mcpWrite=false}try{fs.symlinkSync('config-data.json',${JSON.stringify(root + '/work/.mcp.json')});r.mcpLink=true}catch{r.mcpLink=false}console.log(JSON.stringify(r))`
    const { stdout } = await exec('/usr/bin/sandbox-exec', [
      '-p',
      profile,
      process.execPath,
      '-e',
      code,
    ])
    assert.deepEqual(JSON.parse(stdout), {
      work: true,
      outside: false,
      auth: true,
      privateRead: false,
      mcpWrite: false,
      mcpLink: false,
    })
  },
)

for (const linked of [false, true])
  test('拒绝已有 MCP 配置（含符号链接），linked=' + linked, async (t) => {
    const root = await mkdtemp('/private/tmp/cmap-kimi-mcp-')
    t.after(() => rm(root, { recursive: true, force: true }))
    if (linked) {
      await writeFile(root + '/payload.json', '{}')
      await symlink(root + '/payload.json', root + '/.mcp.json')
    } else await writeFile(root + '/.mcp.json', '{}')
    await assert.rejects(assertNoProjectMcp(root), /MCP/)
  })

test('拒绝继承 Git 根目录的 MCP 配置', async (t) => {
  const root = await mkdtemp('/private/tmp/cmap-kimi-parent-mcp-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(root + '/.git')
  await mkdir(root + '/tasks/current', { recursive: true })
  await writeFile(root + '/.mcp.json', '{}')
  await assert.rejects(assertNoProjectMcp(root + '/tasks/current'), /MCP/)
})
