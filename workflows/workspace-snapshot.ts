/**
 * 额度续接的原工作区快照（ADR-0009 §3）：有写副作用的任务不共享可写工作区，
 * 而是把原工作区打包成冻结输入，续接任务在自己的新工作区解包。只在 Activity 里调用。
 *
 * 只收普通文件与目录：跳过符号链接（解包时可能被用来越界）与顶层 inputs/（冻结输入另行交付）。
 * 按路径排序，同一工作区打包出逐字节相同的快照，重试幂等。UTF-8 文本按原文存放，凭据扫描对其有效。
 */
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { safeMkdir } from './artifact-files.ts'

export const WORKSPACE_SNAPSHOT_ROLE = 'workspace_snapshot'
/** 与证据文件上限一致：超过即失败关闭，不截断。 */
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024

interface SnapshotFile {
  readonly path: string
  readonly mode: number
  readonly encoding: 'utf8' | 'base64'
  readonly content: string
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

export async function packWorkspace(dir: string): Promise<{ bytes: Buffer; fileCount: number }> {
  const files: SnapshotFile[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const entry of (await readdir(join(dir, rel), { withFileTypes: true })).toSorted(byName)) {
      if (!rel && entry.name === 'inputs') continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const bytes = await readFile(join(dir, path))
        const text = bytes.toString('utf8')
        const utf8 = Buffer.from(text, 'utf8').equals(bytes)
        files.push({ path, mode: (await lstat(join(dir, path))).mode & 0o777, encoding: utf8 ? 'utf8' : 'base64', content: utf8 ? text : bytes.toString('base64') })
      }
    }
  }
  await walk('')
  const bytes = Buffer.from(JSON.stringify({ files }))
  if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('WORKSPACE_SNAPSHOT_TOO_LARGE')
  return { bytes, fileCount: files.length }
}

/** 解包到新工作区。路径不得越界或写进 inputs/；已存在的文件（重试）内容必须一致。 */
export async function unpackWorkspace(dir: string, bytes: Buffer): Promise<void> {
  const { files } = JSON.parse(bytes.toString('utf8')) as { files: SnapshotFile[] }
  for (const file of files) {
    const parts = file.path.split('/')
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\')) || parts[0] === 'inputs') {
      throw new Error('WORKSPACE_SNAPSHOT_INVALID')
    }
    const content = Buffer.from(file.content, file.encoding)
    const target = join(await safeMkdir(dir, parts.slice(0, -1)), parts.at(-1)!)
    try {
      await writeFile(target, content, { flag: 'wx', mode: file.mode })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const st = await lstat(target)
      if (!st.isFile() || !(await readFile(target)).equals(content)) throw new Error('WORKSPACE_SNAPSHOT_CONFLICT')
    }
  }
}
