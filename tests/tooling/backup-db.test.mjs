import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expiredBackups } from '../../scripts/backup-db.mjs'

test('只保留最近 N 份，按文件名里的 UTC 时间戳而非输入顺序判断', () => {
  const names = [
    'cmap-20261020T010000Z.dump',
    'cmap-20261022T010000Z.dump',
    'cmap-20261021T010000Z.dump',
  ]
  assert.deepEqual(expiredBackups(names, 'cmap', 2), ['cmap-20261020T010000Z.dump'])
  assert.deepEqual(expiredBackups(names, 'cmap', 3), [])
})

test('只处理本库自己的备份，不碰其他库、半成品或无关文件', () => {
  const names = [
    'cmap-20261020T010000Z.dump',
    'cmap-20261021T010000Z.dump',
    'temporal-20261019T010000Z.dump',
    'notes.txt',
    'cmap-20261021T010000Z.dump.partial',
  ]
  assert.deepEqual(expiredBackups(names, 'cmap', 1), ['cmap-20261020T010000Z.dump'])
})
