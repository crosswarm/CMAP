-- CMAP Task Ledger 表结构
--
-- 设计原则：能落在数据库层的约束就不要靠应用代码自觉。
-- 应用代码会被绕过、会有并发窗口，数据库约束不会。

-- lamport 逻辑时钟。用 sequence 保证并发下严格递增；
-- 事务回滚会留下空洞，这没关系——只需要单调，不需要连续。
CREATE SEQUENCE IF NOT EXISTS lamport_seq;

CREATE TABLE IF NOT EXISTS missions (
  id                TEXT PRIMARY KEY,
  tenant            TEXT NOT NULL,
  owner             TEXT NOT NULL,
  type              TEXT NOT NULL,
  goal              TEXT NOT NULL,
  constraints       JSONB NOT NULL DEFAULT '{}',
  acceptance        JSONB NOT NULL DEFAULT '[]',
  workflow_template TEXT NOT NULL,
  state             TEXT NOT NULL,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS missions_tenant_idx ON missions (tenant, state);

CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  mission_id         TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  parent_task_id     TEXT,
  -- 返工时指向被取代的前一轮 Task。返工创建新 Task 而非原地重跑，
  -- 以保留证据历史与因果链。
  supersedes_task_id TEXT,
  capability         TEXT NOT NULL,
  risk               TEXT NOT NULL CHECK (risk IN ('read-meta','read-sensitive','controlled','mutating')),
  state              TEXT NOT NULL,
  attempt            INTEGER NOT NULL DEFAULT 1,
  max_attempts       INTEGER NOT NULL DEFAULT 1,
  lamport            BIGINT NOT NULL DEFAULT 0,
  envelope           JSONB NOT NULL,
  result             JSONB,
  binding            JSONB,
  deps               TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_mission_state_idx ON tasks (mission_id, state);
CREATE INDEX IF NOT EXISTS tasks_capability_idx ON tasks (capability);

-- 事件流（Transactional Outbox）。
-- 与状态变更同事务提交，保证「状态变了但事件丢了」不可能发生。
CREATE TABLE IF NOT EXISTS events (
  event_id        TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  event_version   INTEGER NOT NULL DEFAULT 1,
  occurred_at     TIMESTAMPTZ NOT NULL,
  mission_id      TEXT NOT NULL,
  task_id         TEXT,
  attempt         INTEGER,
  actor_type      TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  runner_id       TEXT,
  causation_id    TEXT,
  correlation_id  TEXT NOT NULL,
  trace_id        TEXT,
  lamport         BIGINT NOT NULL,
  -- 幂等去重交给数据库唯一约束，而非应用层先查后写：
  -- 后者存在并发窗口，两个请求可以同时查到「不存在」。
  idempotency_key TEXT NOT NULL UNIQUE,
  payload         JSONB NOT NULL DEFAULT '{}',
  delivered_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS events_mission_lamport_idx ON events (mission_id, lamport);
-- 未投递事件的扫描是高频操作，只索引未投递的行
CREATE INDEX IF NOT EXISTS events_undelivered_idx ON events (lamport) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id  TEXT PRIMARY KEY,
  mission_id   TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  role         TEXT NOT NULL,
  uri          TEXT NOT NULL,
  media_type   TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  -- 内容寻址。长度由数据库强制，防止写入截断或占位值。
  sha256       TEXT NOT NULL CHECK (char_length(sha256) = 64),
  version      INTEGER NOT NULL DEFAULT 1,
  state        TEXT NOT NULL,
  producer     JSONB NOT NULL,
  provenance   JSONB NOT NULL DEFAULT '{}',
  retention    JSONB NOT NULL,
  security     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (task_id, role, version)
);

CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts (task_id);

-- 证据血缘。外键保证两端 artifact 都存在——悬空边会让追溯链断裂，
-- 且断在哪里无从发现。
CREATE TABLE IF NOT EXISTS artifact_edges (
  source_artifact_id TEXT NOT NULL REFERENCES artifacts (artifact_id) ON DELETE CASCADE,
  target_artifact_id TEXT NOT NULL REFERENCES artifacts (artifact_id) ON DELETE CASCADE,
  relation           TEXT NOT NULL CHECK (relation IN ('DERIVED_FROM','SUPERSEDES')),
  PRIMARY KEY (source_artifact_id, target_artifact_id, relation)
);

CREATE INDEX IF NOT EXISTS artifact_edges_source_idx ON artifact_edges (source_artifact_id);

CREATE TABLE IF NOT EXISTS reviews (
  id                TEXT PRIMARY KEY,
  mission_id        TEXT NOT NULL,
  reviewed_task_ids TEXT[] NOT NULL,
  round             INTEGER NOT NULL,
  decision          JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS reviews_mission_idx ON reviews (mission_id, round);

CREATE TABLE IF NOT EXISTS approvals (
  id                    TEXT PRIMARY KEY,
  mission_id            TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  action                TEXT NOT NULL,
  -- controlled 与 mutating 互不蕴含，故 scope 必须显式区分，
  -- 不能用单一布尔「已批准」表达。
  scope                 TEXT NOT NULL CHECK (scope IN ('controlled','mutating')),
  requested_by          TEXT NOT NULL,
  risk_level            TEXT NOT NULL,
  reason                TEXT NOT NULL,
  evidence_artifact_ids TEXT[] NOT NULL DEFAULT '{}',
  decision              TEXT NOT NULL CHECK (decision IN ('pending','approved','rejected','expired')),
  decided_by            TEXT,
  decided_at            TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL,
  -- 已决策的审批必须记录决策人与时间。防止出现「不知谁批的」记录，
  -- 那会让审计流在最关键的地方失效。
  CONSTRAINT approvals_decided_has_actor CHECK (
    decision = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals (mission_id) WHERE decision = 'pending';

CREATE TABLE IF NOT EXISTS resource_locks (
  lock_id          TEXT PRIMARY KEY,
  resource         TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  mission_id       TEXT NOT NULL,
  holder_runner_id TEXT NOT NULL,
  acquired_at      TIMESTAMPTZ NOT NULL,
  -- TTL 必填且必须晚于获取时间：没有 TTL 的锁在 runner 崩溃后
  -- 会永久占住真机。
  expires_at       TIMESTAMPTZ NOT NULL,
  released_at      TIMESTAMPTZ,
  CONSTRAINT locks_ttl_positive CHECK (expires_at > acquired_at)
);

CREATE INDEX IF NOT EXISTS locks_resource_idx ON resource_locks (resource) WHERE released_at IS NULL;
