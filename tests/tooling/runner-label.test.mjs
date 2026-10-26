import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runnerLabel } from '../../scripts/runner-label.mjs'

test('runnerLabel：默认仍是生产在用的 com.cmap.runner，CMAP_RUNNER_LABEL 可覆盖（多服务端各用各的服务名）', () => {
  assert.equal(runnerLabel({}), 'com.cmap.runner')
  assert.equal(runnerLabel({ CMAP_RUNNER_LABEL: '  ' }), 'com.cmap.runner')
  assert.equal(runnerLabel({ CMAP_RUNNER_LABEL: 'com.cmap.runner.staging' }), 'com.cmap.runner.staging')
})

test('runnerLabel：服务名会拼进远程 shell 命令，只接受字母数字与 . _ -', () => {
  for (const bad of ['a b', 'x;rm -rf /', '$(id)', "a'b", 'a/b', '-x']) {
    assert.throws(() => runnerLabel({ CMAP_RUNNER_LABEL: bad }), /CMAP_RUNNER_LABEL/, bad)
  }
})
