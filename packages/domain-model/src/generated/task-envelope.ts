/* eslint-disable */
/**
 * 本文件由 schemas/task-envelope.v1.schema.json 自动生成，请勿手改。
 * 重新生成：npm run codegen
 */

/**
 * 控制面派发给 Agent 的任务契约。必须自洽——被派发的 worker 不继承任何上下文，信封本身要包含执行所需的全部信息。 Legacy Activity task creation uses a stable logical creationKey (default initial within a Mission); distinct direct intents use distinct keys. Task IDs derive from Mission and logical key, never a fresh retry timestamp. Review followups have stable indexed keys.
 */
export interface TaskEnvelopeV1 {
  schema: 'cmap/task-envelope/v1'
  identity: {
    mission_id: string
    task_id: string
    /**
     * DAG Mission 中的逻辑节点标识。物理 Task/Review ID 仍由控制面派生。
     */
    plan_node_id?: string
    parent_task_id?: string | null
    /**
     * 返工时指向被取代的前一轮 Task。返工创建新 Task 而非复用，以保留证据历史与因果链。
     */
    supersedes_task_id?: string | null
    correlation_id?: string
    /**
     * 外部副作用去重键。即使引擎声称 exactly-once，超时后也无法确认副作用是否已发生。
     */
    idempotency_key: string
    revision: number
    /**
     * 逻辑时钟。跨主机排序一律不依赖各机器 wall clock。
     */
    lamport?: number
    tenant?: string
    /**
     * 发起人，用于审计与授权归属
     */
    owner?: string
  }
  classification: {
    task_type: string
    /**
     * 按能力路由，而非硬编码 Agent 名，以支持替补与降级
     */
    requested_capability: string
    /**
     * 与 yonwork-cli-adapter 既有风险模型对齐。controlled 与 mutating 的授权互不蕴含，不得合并为单一批准。
     */
    risk_level: 'read-meta' | 'read-sensitive' | 'controlled' | 'mutating'
    priority?: number
    confidentiality?: 'public' | 'internal' | 'restricted'
  }
  goal: {
    statement: string
    /**
     * 机读验收断言。这是自主闭环的命门：验收标准可机读，Reviewer 才能自主判定通过或打回，否则闭环退化为人工判读。
     *
     * @minItems 1
     */
    success_definition: [
      {
        criterion_id: string
        metric: string
        operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq' | 'contains' | 'not_contains'
        expected: unknown
        unit?: string
        /**
         * true 表示由确定性程序判定。软判断不得覆盖硬指标。
         */
        hard_gate?: boolean
      },
      ...{
        criterion_id: string
        metric: string
        operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq' | 'contains' | 'not_contains'
        expected: unknown
        unit?: string
        /**
         * true 表示由确定性程序判定。软判断不得覆盖硬指标。
         */
        hard_gate?: boolean
      }[]
    ]
  }
  inputs?: {
    /**
     * 上下文寻址。跨主机执行禁用本机绝对路径——runner 侧自行 checkout。
     */
    context?: {
      repo: string
      /**
       * 钉死 commit SHA，保证跨主机可复现。不接受分支名或 tag。
       */
      ref: string
      /**
       * 仓库内相对路径。禁止绝对路径与 .. 逃逸。
       */
      paths?: string[]
    }
    artifact_refs?: {
      artifact_id: string
      uri?: string
      role: string
      sha256?: string | null
    }[]
    /**
     * 任务特定参数，形状由 task_type 决定，此处刻意保持自由
     */
    parameters?: {
      [k: string]: unknown
    }
    context_summary?: string
  }
  environment: {
    application_version?: string
    device_selector?: {
      profile?: string
      preferred_device_id?: string
    }
    tenant?: string
    /**
     * 只允许凭据引用，绝不内联凭据明文
     */
    account_ref?: string
    network_profile?: string
    cache_mode?: 'cold' | 'warm'
    locale?: string
  }
  execution_policy: {
    assigned_role?: string
    /**
     * 首选 Agent ID；设置时只允许该 Agent 及显式 fallback_agents 候选，按声明顺序在启动前检查能力、风险上限和健康。
     */
    preferred_agent?: string
    /**
     * 显式替补 Agent ID。无首选时按此列表选择；均未设置时按 runner 注册顺序。任务启动后不得自动切换，后续操作严格使用已落账 binding.adapter。
     */
    fallback_agents?: string[]
    /**
     * 派发时解析出的模型与努力度快照。信封必须自洽——runner 不回查 Agent 注册表，因此携带的是解析后的最终值。
     */
    model_policy?: {
      model: string
      /**
       * 统一抽象档位，各家取值不同（codex 走 model_reasoning_effort），由 Adapter 负责映射。不支持的档位须降级并如实标注，不得静默套用默认值。
       */
      effort: 'low' | 'medium' | 'high' | 'xhigh'
      /**
       * 取值来源，UI 据此显示「继承 Agent 默认」或「本 Task 覆盖」。派发时快照而非读取时回算——Agent 默认值可能在派发后被改，回算会得出错误结论。
       */
      source: 'agent_default' | 'task_override'
    }
    /**
     * 真机、computer-use 等资源只在特定主机上可用
     */
    affinity?: {
      host?: string
    }
    timeout_seconds: number
    max_attempts: number
    heartbeat_seconds?: number
    max_cost_units?: number
    required_resource_locks?: {
      resource: string
      /**
       * 锁必须带 TTL 且可抢占——runner 崩溃不得永久占住真机
       */
      ttl_seconds: number
    }[]
    retry?: {
      retryable_error_codes?: string[]
      initial_interval_seconds?: number
      backoff_coefficient?: number
      max_interval_seconds?: number
    }
  }
  permissions: {
    filesystem?: {
      read?: string[]
      write?: string[]
    }
    repository?: {
      read?: boolean
      write?: boolean
      allow_push_branches?: string[]
      deny_push?: string[]
    }
    /**
     * 只暴露 yonwork-cli-adapter 已封装的能力。不得绕过 adapter 直调 yonworkctl 裸命令。
     */
    yonwork?: {
      launch_app?: boolean
      clear_test_data?: boolean
      query_monitor?: boolean
      capture_trace?: boolean
      chat_send?: boolean
      gateway_control?: boolean
    }
    /**
     * 显式禁止项，例如 production_access、delete_non_test_data、modify_access_control
     */
    forbidden: string[]
  }
  evidence_requirements: {
    /**
     * 声明的产物缺失即判 failed。不得仅凭进程 rc=0 标记成功。
     *
     * @minItems 1
     */
    required_artifact_roles: [string, ...string[]]
    minimum_trace_coverage_ratio?: number
    artifact_retention_days?: number
  }
  output_contract: {
    schema_uri: 'https://cmap.local/schemas/task-result/v1'
    final_statuses?: ('completed' | 'failed' | 'input_required' | 'auth_required' | 'canceled' | 'rejected')[]
  }
  callbacks?: {
    status_event_endpoint?: string
    artifact_endpoint?: string
    approval_endpoint?: string
  }
}
