import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const path = join(process.cwd(), 'docs/user-stories/cmap-runnable-gaps.json')
const stories = JSON.parse(readFileSync(path, 'utf8'))

if (!Array.isArray(stories) || stories.length === 0) throw new Error('用户故事不能为空')

for (const [i, story] of stories.entries()) {
  if (typeof story.description !== 'string' || !story.description) {
    throw new Error(`故事 ${i + 1} 缺 description`)
  }
  if (!Array.isArray(story.steps) || story.steps.length === 0) {
    throw new Error(`故事 ${i + 1} 缺验收步骤`)
  }
  if (typeof story.passes !== 'boolean') throw new Error(`故事 ${i + 1} 缺 passes`)
}

const passed = stories.filter((story) => story.passes).length
console.log(`cmap-runnable-gaps: ${passed}/${stories.length} passing`)
process.exitCode = passed === stories.length ? 0 : 1
