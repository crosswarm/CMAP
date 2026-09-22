import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAdapterNames } from '../../apps/worker/src/adapter-config.ts'

test('Worker 默认 Codex，显式注册顺序决定无首选时的候选顺序', () => {
  assert.deepEqual(parseAdapterNames(), ['codex'])
  assert.deepEqual(parseAdapterNames('kimi, codex'), ['kimi', 'codex'])
  assert.deepEqual(parseAdapterNames('kimi'), ['kimi'])
  assert.deepEqual(parseAdapterNames('codex,kimi,yonwork'), ['codex','kimi','yonwork'])
})
test('Worker 拒绝空注册、未知 Agent 和重复项', () => {
  for (const value of ['', 'codex,', 'unknown', 'kimi,kimi']) {
    assert.throws(() => parseAdapterNames(value), /CMAP_AGENTS/)
  }
})
