#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv from 'ajv/dist/2020.js'

const DEFAULT_BRIDGE = '~/.codex/skills/yoncockpit-autonomous-validation/scripts/yonwork-cli-adapter.mjs'
const TIMEOUT_MS = 60_000
const MAX_BUFFER = 256 * 1024
const allowedFlags = new Set(['--bridge', '--cli', '--user-data-dir'])
const allowedErrors = new Set([
  'cli-usage',
  'host-api-auth',
  'host-resource-not-found',
  'host-protocol-or-response',
  'command-timeout',
  'host-runtime-not-running',
  'cli-execution-error',
  'cli-spawn-error',
  'host-api-override-detected',
  'bridge-timeout',
  'bridge-error',
  'invalid-json',
  'unknown',
])
const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/
const validateOutput = new Ajv({ strict: true, allErrors: true }).compile(JSON.parse(
  readFileSync(new URL('../schemas/yonwork-probe.v1.schema.json', import.meta.url), 'utf8'),
))

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex')
const argValue = (args, name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}
const validateArgs = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (!allowedFlags.has(name) || index + 1 >= args.length || args[index + 1].startsWith('--')) return false
    index += 1
  }
  return true
}
const baseOutput = (runtimeSource, env) => ({
  schema: 'cmap/yonwork-probe/v1',
  observation_scope: 'transport_only',
  availability: 'error',
  cli_version: null,
  host_state: 'unknown',
  gateway_state: 'unknown',
  registry_state: 'unknown',
  runtime_source: runtimeSource,
  override_present: {
    host_api_url: Boolean(env.YONCLAW_HOST_API_URL),
    host_api_token: Boolean(env.YONCLAW_HOST_API_TOKEN),
  },
  probes: {},
})

const existingRuntimeDir = (file) => {
  try {
    const link = lstatSync(file)
    const target = link.isSymbolicLink() ? statSync(file) : link
    return target.isFile() ? dirname(file) : null
  } catch {
    return null
  }
}

export function selectRuntime({ args = [], env = process.env, platform = process.platform } = {}) {
  const explicit = argValue(args, '--user-data-dir')
  if (explicit) return { source: 'explicit', userDataDir: explicit }
  if (env.YONCLAW_USER_DATA_DIR) return { source: 'environment', userDataDir: env.YONCLAW_USER_DATA_DIR }
  if (platform === 'darwin') {
    const home = env.HOME || homedir()
    const candidates = [
      ['yonwork', join(home, 'Library/Application Support/YonWork/host-api-runtime.json')],
      ['yonclaw', join(home, 'Library/Application Support/YonClaw/host-api-runtime.json')],
      ['yonclaw', join(home, 'Library/Application Support/yonclaw/host-api-runtime.json')],
    ]
    for (const [source, file] of candidates) {
      const userDataDir = existingRuntimeDir(file)
      if (userDataDir) return { source, userDataDir }
    }
  }
  return { source: 'platform_default', userDataDir: null }
}

const normalizeProbe = (probe) => ({
  code: Number.isInteger(probe?.exitCode) && probe.exitCode >= 0 ? probe.exitCode : null,
  error: typeof probe?.errorClass === 'string'
    ? allowedErrors.has(probe.errorClass) ? probe.errorClass : 'unknown'
    : null,
  hash: /^[a-f0-9]{64}$/.test(probe?.outputHash || '') ? probe.outputHash : null,
})

const state = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback

const sanitizeBridgeJson = (data, runtimeSource, env) => {
  const output = baseOutput(runtimeSource, env)
  const fingerprint = data?.hostCliFingerprint || {}
  const override = data?.environmentOverridePresence || {}
  output.override_present = {
    host_api_url: output.override_present.host_api_url || Boolean(override.YONCLAW_HOST_API_URL),
    host_api_token: output.override_present.host_api_token || Boolean(override.YONCLAW_HOST_API_TOKEN),
  }
  const blocked = data?.status === 'blocked' || data?.errorClass === 'host-api-override-detected'
  output.availability = blocked
    ? 'blocked'
    : fingerprint.availability === 'available' ? 'available' : 'unavailable'
  output.cli_version = semverPattern.test(fingerprint.version || '') ? fingerprint.version : null
  output.host_state = blocked ? 'blocked' : state(fingerprint.hostStatus, ['running', 'not-running', 'auth-failed', 'timeout', 'unknown'])
  output.gateway_state = blocked ? 'blocked' : state(fingerprint.gatewayState, ['reachable', 'not-running', 'auth-failed', 'timeout', 'unknown'])
  output.registry_state = blocked ? 'blocked' : state(fingerprint.skillRegistryStatus, ['reported', 'not-running', 'auth-failed', 'timeout', 'unknown'])
  const probes = data?.probes || {}
  for (const [from, to] of [
    ['routes', 'routes'],
    ['status', 'status'],
    ['gatewayStatus', 'gateway_status'],
    ['gatewayHealth', 'gateway_health'],
    ['skillRegistryStatus', 'skill_registry_status'],
  ]) {
    if (probes[from]) output.probes[to] = normalizeProbe(probes[from])
  }
  if (blocked) {
    output.probes.bridge = {
      code: 5,
      error: 'host-api-override-detected',
      hash: null,
    }
  }
  return output
}

const finish = (output, exitCode) => {
  if (!validateOutput(output)) {
    const fallback = baseOutput(output.runtime_source || 'platform_default', { YONCLAW_HOST_API_URL: '', YONCLAW_HOST_API_TOKEN: '' })
    fallback.probes.bridge = { code: null, error: 'bridge-error', hash: null }
    Object.defineProperty(fallback, '_exitCode', { value: 1 })
    return fallback
  }
  Object.defineProperty(output, '_exitCode', { value: exitCode })
  return output
}

export async function probeYonWork({ args = process.argv.slice(2), env = process.env, platform = process.platform } = {}) {
  if (!validateArgs(args)) {
    const output = baseOutput('platform_default', env)
    output.probes.bridge = { code: null, error: 'cli-usage', hash: null }
    return finish(output, 1)
  }
  const runtime = selectRuntime({ args, env, platform })
  const bridgeArg = argValue(args, '--bridge') || DEFAULT_BRIDGE
  const cli = argValue(args, '--cli')
  const home = env.HOME || homedir()
  const bridge = bridgeArg.startsWith('~/') ? join(home, bridgeArg.slice(2)) : bridgeArg
  const childEnv = { ...env }
  if (runtime.userDataDir) childEnv.YONCLAW_USER_DATA_DIR = runtime.userDataDir
  const childArgs = [resolve(bridge), 'probe']
  if (cli) childArgs.push('--cli', cli)
  const result = spawnSync(process.execPath, childArgs, {
    encoding: 'utf8',
    env: childEnv,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  })
  const outputHash = sha256(`${result.stdout || ''}\n${result.stderr || ''}`)
  if (result.error) {
    const output = baseOutput(runtime.source, env)
    output.probes.bridge = {
      code: null,
      error: result.error.code === 'ETIMEDOUT' ? 'bridge-timeout' : 'bridge-error',
      hash: outputHash,
    }
    return finish(output, 1)
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    const output = baseOutput(runtime.source, env)
    output.probes.bridge = { code: result.status, error: 'invalid-json', hash: outputHash }
    return finish(output, 1)
  }
  const output = sanitizeBridgeJson(parsed, runtime.source, env)
  const exitCode = output.availability === 'blocked' ? 5 : result.status || 0
  return finish(output, exitCode)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await probeYonWork()
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result._exitCode
}
