/**
 * 副作用导入：把 HOME 指向一次性目录。CodexAdapter 的 standalone 结果目录在 `~/.cmap` 下，
 * 不隔离的话测试会往真实家目录留垃圾。不以 .test.ts 结尾，避免被当作独立用例。
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(realpathSync(tmpdir()), 'cmap-test-home-'))
process.env['HOME'] = home
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
