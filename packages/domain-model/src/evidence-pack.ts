/**
 * Evidence Pack：把一个 Mission 的全部证据聚合成评审者可一次性消费的结构。
 *
 * 评审要回答的是「结论是否成立」，这需要同时看到：产出了什么证据、
 * 各条验收标准的实测值、以及证据之间的派生关系。分散在多次查询里
 * 意味着评审者要自己拼装，容易漏。
 */

import type { Store } from './store.ts'
import type { Artifact, ArtifactEdge } from './entities.ts'
import type { TaskResultV1 } from './generated/task-result.ts'
import { NotFoundError } from './store.ts'

export interface EvidencePackTask {
  readonly taskId: string
  readonly capability: string
  readonly state: string
  readonly artifacts: readonly Artifact[]
  /** 逐条验收结论。任务尚无结果时为空数组。 */
  readonly criterionResults: NonNullable<TaskResultV1['criterion_results']>
}

export interface EvidencePack {
  readonly missionId: string
  readonly goal: string
  readonly tasks: readonly EvidencePackTask[]
  /** 证据之间的派生与取代关系，用于回答「这个结论基于哪些证据」。 */
  readonly edges: readonly ArtifactEdge[]
}

/**
 * Mission 不存在时抛错而非返回空包——静默返回空包会让调用方误以为
 * 「这个 Mission 没有证据」，而实际是 Mission 根本不存在。
 */
export const buildEvidencePack = async (
  store: Store,
  missionId: string,
): Promise<EvidencePack> => {
  const mission = await store.getMission(missionId)
  if (!mission) throw new NotFoundError('Mission', missionId)

  const tasks = await store.queryTasks({ missionId })

  const packTasks: EvidencePackTask[] = []
  const edges: ArtifactEdge[] = []

  for (const t of tasks) {
    const artifacts = await store.listArtifacts(t.id)

    for (const a of artifacts) {
      edges.push(...(await store.listLineage(a.artifact_id)))
    }

    packTasks.push({
      taskId: t.id,
      capability: t.capability,
      state: t.state,
      artifacts,
      criterionResults: t.result?.criterion_results ?? [],
    })
  }

  return { missionId, goal: mission.goal, tasks: packTasks, edges }
}
