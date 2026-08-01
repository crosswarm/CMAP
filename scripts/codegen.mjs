/**
 * 从 schemas/*.schema.json 生成 TypeScript 类型。
 *
 * Schema 是单一真相源，TS 类型是它的派生物——不手写、不手改。
 *
 * 关于顶层 allOf：
 * review-decision 用顶层 allOf(if/then) 表达条件必填（rework 时必须带
 * failed_criteria/required_followups/stop_conditions）。这类约束无法用
 * TypeScript 的结构类型表达，而 json-schema-to-typescript 遇到顶层 allOf
 * 会降级成 `{[k: string]: unknown} & {...}` 交叉类型——那个索引签名会在
 * 类型层面放行任意额外字段，恰好抵消 additionalProperties:false 的意图。
 *
 * 因此生成前剥掉顶层 allOf：类型只表达「结构」，条件约束由 ajv 在运行时
 * 执行。两者各司其职，都不放松。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { compile } from 'json-schema-to-typescript'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const schemaDir = join(root, 'schemas')
const outDir = join(root, 'packages/domain-model/src/generated')

const TARGETS = [
  { schema: 'task-envelope.v1.schema.json', out: 'task-envelope.ts' },
  { schema: 'task-result.v1.schema.json', out: 'task-result.ts' },
  { schema: 'review-decision.v1.schema.json', out: 'review-decision.ts' },
]

mkdirSync(outDir, { recursive: true })

for (const { schema: schemaFile, out } of TARGETS) {
  const raw = JSON.parse(readFileSync(join(schemaDir, schemaFile), 'utf8'))

  const hadAllOf = Array.isArray(raw.allOf)
  const structural = structuredClone(raw)
  delete structural.allOf

  const conditionalNote = hadAllOf
    ? `\n *\n * 注意：本 Schema 含顶层 allOf(if/then) 条件必填约束，无法用 TypeScript\n * 结构类型表达。类型检查通过不代表满足契约——运行时仍须经 ajv 校验。`
    : ''

  const ts = await compile(structural, structural.title ?? out, {
    bannerComment: `/* eslint-disable */
/**
 * 本文件由 schemas/${schemaFile} 自动生成，请勿手改。
 * 重新生成：npm run codegen${conditionalNote}
 */`,
    additionalProperties: false,
    style: { semi: false, singleQuote: true },
  })

  writeFileSync(join(outDir, out), ts, 'utf8')
  console.log(`生成 ${out}${hadAllOf ? '（已剥离顶层 allOf，条件约束由 ajv 保证）' : ''}`)
}
