import { isDeepStrictEqual } from 'node:util'

import type { Mission } from './entities.ts'

export class MissionConflictError extends Error {
  constructor(id: string) {
    super(`Mission ${id} 创建参数与既有记录不一致`)
    this.name = 'MissionConflictError'
  }
}

const comparableMissionInput = (m: Mission) => ({
  tenant: m.tenant,
  owner: m.owner,
  type: m.type,
  goal: m.goal,
  constraints: m.constraints,
  acceptance: m.acceptance,
  workflow_template: m.workflow_template,
})

export const assertSameMissionInput = (existing: Mission, incoming: Mission): void => {
  if (!isDeepStrictEqual(comparableMissionInput(existing), comparableMissionInput(incoming))) {
    throw new MissionConflictError(existing.id)
  }
}
