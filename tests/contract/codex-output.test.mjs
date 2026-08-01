import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv from 'ajv/dist/2020.js'

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = join(here, '../../schemas')
const schema = JSON.parse(readFileSync(join(schemaDir, 'codex-output.v1.schema.json'), 'utf8'))

/**
 * OpenAI structured outputs 的 schema 子集比标准 JSON Schema 严格得多。
 * 这些测试锁死那些限制——违反任何一条，codex exec --output-schema 会在
 * 请求阶段就被服务端拒绝（400 invalid_json_schema），任务根本跑不起来。
 *
 * 曾经踩过的具体失败：属性用了裸 const 而无 type 键，报
 * 「In context=('properties','schema'), schema must have a 'type' key」。
 */

/** 遍历 schema 中所有 object 节点的 properties 定义 */
const walkObjects = (node, path = '$', out = []) => {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
    out.push({ path, node })
  }
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) walkObjects(v, `${path}.${k}`, out)
  }
  if (node.items) walkObjects(node.items, `${path}[]`, out)
  return out
}

const walkAll = (node, path = '$', out = []) => {
  if (!node || typeof node !== 'object') return out
  out.push({ path, node })
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) walkAll(v, `${path}.${k}`, out)
  }
  if (node.items) walkAll(node.items, `${path}[]`, out)
  return out
}

describe('codex-output 必须满足 OpenAI structured outputs 限制', () => {
  test('本身是合法 JSON Schema', () => {
    const ajv = new Ajv({ strict: true, allErrors: true })
    assert.ok(ajv.compile(schema))
  })

  test('每个属性都有 type 键（不得使用裸 const）', () => {
    const offenders = []
    for (const { path, node } of walkAll(schema)) {
      if (path === '$') continue
      if (node.type === undefined) offenders.push(path)
    }
    assert.deepEqual(
      offenders,
      [],
      `以下属性缺少 type 键，会被 OpenAI 拒绝：${offenders.join(', ')}`,
    )
  })

  test('每个 object 的所有属性都必须列入 required（不允许可选字段）', () => {
    const offenders = []
    for (const { path, node } of walkObjects(schema)) {
      if (!node.properties) continue
      const props = Object.keys(node.properties)
      const required = node.required ?? []
      const missing = props.filter((p) => !required.includes(p))
      if (missing.length) offenders.push(`${path}: ${missing.join(',')}`)
    }
    assert.deepEqual(
      offenders,
      [],
      `以下属性未列入 required，OpenAI 不支持可选字段（可选语义请用 ["T","null"] 表达）：${offenders.join(' | ')}`,
    )
  })

  test('每个 object 都显式声明 additionalProperties: false', () => {
    const offenders = []
    for (const { path, node } of walkObjects(schema)) {
      if (!node.properties) continue
      if (node.additionalProperties !== false) offenders.push(path)
    }
    assert.deepEqual(offenders, [], `以下 object 缺少 additionalProperties:false：${offenders.join(', ')}`)
  })

  test('不使用 OpenAI 不支持的校验关键字', () => {
    const unsupported = [
      'pattern', 'format', 'minLength', 'maxLength',
      'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
      'minItems', 'maxItems', 'uniqueItems', 'default', 'const',
      'allOf', 'oneOf', 'not', 'if', 'then', 'else',
    ]
    const offenders = []
    for (const { path, node } of walkAll(schema)) {
      for (const k of unsupported) {
        if (k in node) offenders.push(`${path}.${k}`)
      }
    }
    assert.deepEqual(offenders, [], `使用了不受支持的关键字：${offenders.join(', ')}`)
  })
})

describe('codex-output 语义完整性', () => {
  test('顶层字段覆盖账本合成所需的全部内容', () => {
    const props = Object.keys(schema.properties)
    for (const need of ['status', 'summary', 'criterion_results', 'artifacts', 'findings', 'error']) {
      assert.ok(props.includes(need), `缺少字段 ${need}`)
    }
  })

  test('不含身份字段——身份由控制面填充，Agent 无权自述', () => {
    const props = Object.keys(schema.properties)
    for (const forbidden of ['mission_id', 'task_id', 'attempt', 'schema']) {
      assert.ok(
        !props.includes(forbidden),
        `${forbidden} 不应由 Agent 提供：账本归控制面所有，否则异常 Agent 可把结果写到别的任务名下`,
      )
    }
  })

  test('artifact 要求真实文件的三要素：路径、大小、哈希', () => {
    const art = schema.properties.artifacts.items
    for (const need of ['uri', 'size_bytes', 'sha256']) {
      assert.ok(art.required.includes(need), `artifact 缺少必填项 ${need}`)
    }
  })

  test('criterion_results 强制携带证据引用', () => {
    const cr = schema.properties.criterion_results.items
    assert.ok(cr.required.includes('evidence_artifact_ids'), '验收结论必须可追溯到证据')
  })
})
