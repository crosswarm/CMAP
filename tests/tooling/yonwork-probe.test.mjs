// precommit-allow-secrets: 合成 Host API token 赋值用于验证覆盖拒绝与输出脱敏；本文件不包含真实凭据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import Ajv from 'ajv/dist/2020.js'
import { probeYonWork } from '../../scripts/probe-yonwork.mjs'

const schema = JSON.parse(readFileSync(new URL('../../schemas/yonwork-probe.v1.schema.json', import.meta.url), 'utf8'))
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema)

const tempRoot = () => mkdtempSync(join(tmpdir(), 'cmap-yonwork-probe-'))
const fakeBridge = (dir, body) => {
  const file = join(dir, 'bridge.mjs')
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

const runCli = (args, env = {}) => spawnSync(process.execPath, ['scripts/probe-yonwork.mjs', ...args], {
  cwd: new URL('../..', import.meta.url),
  encoding: 'utf8',
  env: { ...process.env, ...env },
})

test('schema compiles and accepts a minimal sanitized transport observation', () => {
  const sample = {
    schema: 'cmap/yonwork-probe/v1',
    observation_scope: 'transport_only',
    availability: 'available',
    cli_version: '1.0.9',
    host_state: 'running',
    gateway_state: 'timeout',
    registry_state: 'timeout',
    runtime_source: 'yonwork',
    override_present: { host_api_url: false, host_api_token: false },
    probes: { status: { code: 0, error: null, hash: 'a'.repeat(64) } },
  }
  assert.ok(validate(sample), JSON.stringify(validate.errors, null, 2))
  assert.equal(validate({ ...sample, runtime_source: '/Users/private' }), false)
})

test('explicit user data dir wins and bridge output is schema-shaped', async () => {
  const dir = tempRoot()
  try {
    const bridge = fakeBridge(dir, `
      import assert from 'node:assert/strict'
      assert.equal(process.argv[2], 'probe')
      assert.equal(process.env.YONCLAW_USER_DATA_DIR, process.env.EXPECTED_USER_DATA_DIR)
      console.log(JSON.stringify({
        hostCliFingerprint: {
          availability: 'available', version: '1.0.9',
          hostStatus: 'running', gatewayState: 'timeout', skillRegistryStatus: 'timeout'
        },
        probes: {
          routes: { exitCode: 0, errorClass: null, outputHash: '${'b'.repeat(64)}' },
          status: { exitCode: 0, errorClass: null, outputHash: '${'c'.repeat(64)}' }
        }
      }))
    `)
    const result = await probeYonWork({
      args: ['--bridge', bridge, '--user-data-dir', join(dir, 'explicit'), '--cli', '/synthetic/yonworkctl'],
      env: { ...process.env, EXPECTED_USER_DATA_DIR: join(dir, 'explicit') },
    })
    assert.equal(result.runtime_source, 'explicit')
    assert.equal(result.availability, 'available')
    assert.equal(result.cli_version, '1.0.9')
    assert.equal(result.host_state, 'running')
    assert.equal(result.gateway_state, 'timeout')
    assert.ok(validate(result), JSON.stringify(validate.errors, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('macOS discovery selects YonWork runtime by stat only and never echoes file contents', async () => {
  const dir = tempRoot()
  const sentinel = 'secret-runtime-token-must-not-appear'
  try {
    mkdirSync(join(dir, 'Library/Application Support/YonWork'), { recursive: true })
    writeFileSync(join(dir, 'Library/Application Support/YonWork/host-api-runtime.json'), sentinel)
    const bridge = fakeBridge(dir, `
      import assert from 'node:assert/strict'
      assert.equal(process.env.YONCLAW_USER_DATA_DIR, process.env.EXPECTED_USER_DATA_DIR)
      console.log(JSON.stringify({ hostCliFingerprint: { availability: 'available', version: '1.0.9' }, probes: {} }))
    `)
    const result = await probeYonWork({
      args: ['--bridge', bridge],
      env: { ...process.env, HOME: dir, EXPECTED_USER_DATA_DIR: join(dir, 'Library/Application Support/YonWork'), YONCLAW_USER_DATA_DIR: '' },
      platform: 'darwin',
    })
    const text = JSON.stringify(result)
    assert.equal(result.runtime_source, 'yonwork')
    assert.equal(text.includes(sentinel), false)
    assert.ok(validate(result), JSON.stringify(validate.errors, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid JSON and extra secret output fail generically without echoing helper output', () => {
  const dir = tempRoot()
  const secret = 'synthetic-secret-output'
  try {
    const bridge = fakeBridge(dir, `console.log('not json ${secret}')`)
    const result = runCli(['--bridge', bridge])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes(secret), false)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.availability, 'error')
    assert.equal(parsed.probes.bridge.error, 'invalid-json')
    assert.ok(validate(parsed), JSON.stringify(validate.errors, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('host API overrides are passed through and remain blocked', () => {
  const dir = tempRoot()
  try {
    const bridge = fakeBridge(dir, `
      if (!process.env.YONCLAW_HOST_API_TOKEN) process.exit(44)
      console.log(JSON.stringify({
        status: 'blocked',
        errorClass: 'host-api-override-detected',
        environmentOverridePresence: { YONCLAW_HOST_API_URL: false, YONCLAW_HOST_API_TOKEN: true },
        hostCliFingerprint: { availability: 'available', version: '1.0.9' }
      }))
      process.exitCode = 5
    `)
    const result = runCli(['--bridge', bridge], { YONCLAW_HOST_API_TOKEN: 'synthetic-token' })
    assert.equal(result.status, 5)
    assert.equal(result.stdout.includes('synthetic-token'), false)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.availability, 'blocked')
    assert.deepEqual(parsed.override_present, { host_api_url: false, host_api_token: true })
    assert.ok(validate(parsed), JSON.stringify(validate.errors, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('valid bridge JSON cannot smuggle secrets through version, errorClass, or negative code', async () => {
  const dir = tempRoot()
  const secret = 'sentinel-private-value'
  try {
    const bridge = fakeBridge(dir, `
      console.log(JSON.stringify({
        hostCliFingerprint: {
          availability: 'available',
          version: '${secret}',
          hostStatus: 'running'
        },
        probes: {
          status: { exitCode: -1, errorClass: '${secret}', outputHash: '${'d'.repeat(64)}' }
        }
      }))
    `)
    const result = await probeYonWork({ args: ['--bridge', bridge] })
    const text = JSON.stringify(result)
    assert.equal(text.includes(secret), false)
    assert.equal(result.cli_version, null)
    assert.deepEqual(result.probes.status, { code: null, error: 'unknown', hash: 'd'.repeat(64) })
    assert.ok(validate(result), JSON.stringify(validate.errors, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing HOME on macOS falls back without throwing or echoing local paths', async () => {
  const dir = tempRoot()
  try {
    const bridge = fakeBridge(dir, `
      console.log(JSON.stringify({ hostCliFingerprint: { availability: 'available', version: '1.0.9' }, probes: {} }))
    `)
    const { HOME, ...envWithoutHome } = process.env
    const result = await probeYonWork({
      args: ['--bridge', bridge],
      env: envWithoutHome,
      platform: 'darwin',
    })
    assert.ok(['yonwork', 'yonclaw', 'platform_default'].includes(result.runtime_source))
    assert.ok(validate(result), JSON.stringify(validate.errors, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown flags fail with generic schema output and do not call bridge or echo flag values', () => {
  const dir = tempRoot()
  const secretPath = '/private/sentinel/path'
  try {
    const bridge = fakeBridge(dir, `console.log('bridge should not run'); process.exit(44)`)
    const result = runCli(['--bridge', bridge, '--unexpected', secretPath])
    assert.equal(result.status, 1)
    assert.equal(result.stdout.includes(secretPath), false)
    assert.equal(result.stderr.includes(secretPath), false)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.availability, 'error')
    assert.equal(parsed.probes.bridge.error, 'cli-usage')
    assert.ok(validate(parsed), JSON.stringify(validate.errors, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
