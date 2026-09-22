import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, link, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import type { Artifact } from '#domain-model'
import { readVerifiedArtifact } from '../packages/adapter-sdk/src/structured-output.ts'

export const INPUT_PAYLOAD = 'payload'

export const inside = (root: string, candidate: string): boolean => {
  const r = relative(root, candidate)
  return r === '' || (!r.startsWith('..') && !r.startsWith('/'))
}

export const safeChildDir = async (workRoot: string, taskId: string): Promise<{ root: string; child: string }> => {
  await mkdir(workRoot, { recursive: true })
  const root = await realpath(workRoot)
  const child = resolve(root, taskId)
  if (!inside(root, child)) throw new Error('DAG child workDir escapes workRoot')
  try {
    const st = await lstat(child)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('DAG child workDir preexists as unsafe path')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      await mkdir(child)
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
    }
  }
  const realChild = await realpath(child)
  if (!inside(root, realChild)) throw new Error('DAG child workDir escapes workRoot')
  return { root, child: realChild }
}

export const existingChildDir = async (workRoot: string, taskId: string): Promise<{ root: string; child: string }> => {
  const root = await realpath(workRoot)
  const child = resolve(root, taskId)
  if (!inside(root, child)) throw new Error('DAG child workDir escapes workRoot')
  const st = await lstat(child)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('DAG child workDir preexists as unsafe path')
  const realChild = await realpath(child)
  if (!inside(root, realChild)) throw new Error('DAG child workDir escapes workRoot')
  return { root, child: realChild }
}

export const safeMkdir = async (root: string, segments: readonly string[]): Promise<string> => {
  const parts = [...segments]
  let current = root
  for (const segment of parts) {
    current = join(current, segment)
    if (!inside(root, resolve(current))) throw new Error('DAG input path escapes workRoot')
    try {
      const st = await lstat(current)
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('DAG input directory symlink is unsafe')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        await mkdir(current)
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
    }
  }
  return current
}

export const existingInputFile = async (root: string, segments: readonly string[]): Promise<string> => {
  const parts = [...segments]
  let current = root
  for (const [index, segment] of parts.entries()) {
    current = join(current, segment)
    if (!inside(root, resolve(current))) throw new Error('DAG input path escapes workRoot')
    const st = await lstat(current)
    if (st.isSymbolicLink()) throw new Error('DAG input path symlink is unsafe')
    if (index === parts.length - 1) {
      if (!st.isFile()) throw new Error('DAG input target symlink is unsafe')
    } else if (!st.isDirectory()) {
      throw new Error('DAG input directory symlink is unsafe')
    }
    if (!inside(root, await realpath(current))) throw new Error('DAG input path escapes workRoot')
  }
  return current
}

export const publishInput = async (dir: string, bytes: Buffer): Promise<void> => {
  const content = Buffer.from(bytes)
  const target = join(dir, INPUT_PAYLOAD)
  try {
    const st = await lstat(target)
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('DAG input target symlink is unsafe')
    const existing = await readFile(target)
    if (!existing.equals(content)) throw new Error('DAG input conflict: existing payload differs')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temp = join(dir, `.tmp-${process.pid}-${randomUUID()}`)
  await writeFile(temp, content, { flag: 'wx' })
  try {
    await link(temp, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const st = await lstat(target)
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('DAG input target symlink is unsafe')
    const existing = await readFile(target)
    if (!existing.equals(content)) throw new Error('DAG input conflict: existing payload differs')
  } finally {
    await rm(temp, { force: true })
  }
}

export const verifiedArtifactBytes = async (
  root: string,
  taskId: string,
  artifact: Artifact,
): Promise<{ bytes: Buffer; sha256: string }> => {
  const dir = resolve(root, taskId)
  if (!inside(root, dir)) throw new Error('DAG parent workDir escapes workRoot')
  const st = await lstat(dir)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('DAG parent workDir symlink is unsafe')
  if (!inside(root, await realpath(dir))) throw new Error('DAG parent workDir escapes workRoot')
  await access(dir, constants.R_OK)
  return readVerifiedArtifact(dir, {
    uri: artifact.uri,
    role: artifact.role,
    sha256: artifact.sha256,
  })
}
