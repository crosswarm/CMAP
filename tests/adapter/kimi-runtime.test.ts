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
import { promisify } from 'node:util'
import {
  buildKimiSandbox,
  assertNoProjectMcp,
} from '../../adapters/kimi-adapter/src/runtime.ts'

const exec = promisify(execFile)
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
    })
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
