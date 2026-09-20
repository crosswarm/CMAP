export type ControlPlaneWorkflowType = 'missionWorkflow' | 'dagMissionWorkflow'

export const workflowTypeForTemplate = (template: string): ControlPlaneWorkflowType =>
  template === 'dag/v1' ? 'dagMissionWorkflow' : 'missionWorkflow'
