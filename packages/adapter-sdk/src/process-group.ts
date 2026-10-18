import type { ChildProcess } from 'node:child_process'

// POSIX detached children owned by the caller; this is not a Windows tree-kill API.

export interface OwnedProcessGroupTermination {
  confirmAbsent(): boolean
}

export const terminateOwnedProcessGroup = (
  child: Pick<ChildProcess, 'pid' | 'kill'>,
): OwnedProcessGroupTermination | null => {
  const pid = child.pid
  if (!pid) return null
  let confirmed = false
  let timer: NodeJS.Timeout | null = null
  const groupAlive = (): boolean => {
    if (confirmed) return false
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      confirmed = true
      if (timer) clearTimeout(timer)
      timer = null
      return false
    }
  }
  const signal = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  if (!groupAlive()) return { confirmAbsent: () => true }
  signal('SIGTERM')
  timer = setTimeout(() => {
    if (!groupAlive()) return
    signal('SIGKILL')
    groupAlive()
  }, 500)
  timer.unref()
  return { confirmAbsent: () => !groupAlive() }
}
