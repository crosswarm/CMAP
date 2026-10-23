import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claudeDispatcher } from '../../workflows/dispatchers.ts'

test('Claude 调度者默认用 Haiku，可经 CMAP_CLAUDE_DISPATCHER_MODEL 覆盖', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cmap-claude-dispatch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const argsFile = join(dir, 'args.json')
  const bin = join(dir, 'claude')
  await writeFile(bin, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))\nprocess.stdout.write(JSON.stringify({ structured_output: { agent_id: 'codex' }, modelUsage: { 'claude-haiku-5-5': {} } }))\n`)
  await chmod(bin, 0o755)
  const input = { capability: 'code.analyze', task_type: 'analyze', declared_risk: 'read-meta', candidates: [{ agent_id: 'codex' }, { agent_id: 'kimi' }] } as never
  const quota = async () => ({ status: 'unknown' }) as never

  const chosen = await claudeDispatcher({ bin, quota }).choose(input)
  assert.equal(chosen.agent_id, 'codex')
  const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[]
  assert.equal(args[args.indexOf('--model') + 1], 'haiku')

  await claudeDispatcher({ bin, quota, model: 'sonnet' }).choose(input)
  const args2 = JSON.parse(await readFile(argsFile, 'utf8')) as string[]
  assert.equal(args2[args2.indexOf('--model') + 1], 'sonnet')
})
