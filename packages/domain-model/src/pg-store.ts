/**
 * Store 的 PostgreSQL 实现。
 *
 * 跑与 MemoryStore 完全相同的契约测试（tests/domain/store-contract.ts）。
 *
 * 内存版靠「先校验后写」模拟事务语义，这里用的是真事务，并且把几处
 * 关键保证下沉到数据库：
 *
 *  - 幂等：靠 events.idempotency_key 的 UNIQUE 约束，而非应用层先查后写。
 *    后者存在并发窗口——两个请求可以同时查到「不存在」然后都写入。
 *  - 乐观并发：条件更新 `WHERE state = $from`，用受影响行数判断，
 *    而非先读再写。
 *  - 资源锁互斥：pg_advisory_xact_lock 把同一 resource 的获取串行化。
 *    只用 SELECT ... FOR UPDATE 不够——没有匹配行时它不阻塞，
 *    两个并发请求会双双查空然后都插入。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

import { assertTransition } from './task-state.ts'
import type { TaskState } from './task-state.ts'
import type {
  Mission,
  MissionState,
  TaskRecord,
  TaskEvent,
  EventActor,
  EventType,
  RemoteTaskBinding,
  Approval,
  ApprovalDecision,
  ResourceLock,
  Artifact,
  Review,
  RiskLevel,
} from './entities.ts'
import type {
  Store,
  CreateMissionInput,
  CreateTaskInput,
  TransitionTaskInput,
  AppendEventInput,
  TaskQuery,
} from './store.ts'
import {
  ConcurrentModificationError,
  NotFoundError,
  WriteVerificationError,
  LockUnavailableError,
} from './store.ts'

const { Pool } = pg
type PoolClient = pg.PoolClient

const UNIQUE_VIOLATION = '23505'

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v)

const isoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : iso(v)

// -------------------------------------------------------------- 行映射

const toMission = (r: Record<string, unknown>): Mission => ({
  id: r['id'] as string,
  tenant: r['tenant'] as string,
  owner: r['owner'] as string,
  type: r['type'] as string,
  goal: r['goal'] as string,
  constraints: r['constraints'] as Record<string, unknown>,
  acceptance: r['acceptance'] as Mission['acceptance'],
  workflow_template: r['workflow_template'] as string,
  state: r['state'] as MissionState,
  revision: Number(r['revision']),
  created_at: iso(r['created_at']),
  updated_at: iso(r['updated_at']),
})

const toTask = (r: Record<string, unknown>): TaskRecord => ({
  id: r['id'] as string,
  mission_id: r['mission_id'] as string,
  parent_task_id: (r['parent_task_id'] as string | null) ?? null,
  supersedes_task_id: (r['supersedes_task_id'] as string | null) ?? null,
  capability: r['capability'] as string,
  risk: r['risk'] as RiskLevel,
  state: r['state'] as TaskState,
  attempt: Number(r['attempt']),
  max_attempts: Number(r['max_attempts']),
  lamport: Number(r['lamport']),
  envelope: r['envelope'] as TaskRecord['envelope'],
  result: (r['result'] as TaskRecord['result']) ?? null,
  binding: (r['binding'] as TaskRecord['binding']) ?? null,
  deps: (r['deps'] as string[]) ?? [],
  created_at: iso(r['created_at']),
  updated_at: iso(r['updated_at']),
})

const toEvent = (r: Record<string, unknown>): TaskEvent => {
  const actor: EventActor = {
    type: r['actor_type'] as EventActor['type'],
    id: r['actor_id'] as string,
    ...(r['runner_id'] ? { runner_id: r['runner_id'] as string } : {}),
  }
  return {
    event_id: r['event_id'] as string,
    event_type: r['event_type'] as EventType,
    event_version: Number(r['event_version']),
    occurred_at: iso(r['occurred_at']),
    mission_id: r['mission_id'] as string,
    task_id: (r['task_id'] as string | null) ?? null,
    attempt: r['attempt'] === null ? null : Number(r['attempt']),
    actor,
    causation_id: (r['causation_id'] as string | null) ?? null,
    correlation_id: r['correlation_id'] as string,
    trace_id: (r['trace_id'] as string | null) ?? null,
    lamport: Number(r['lamport']),
    idempotency_key: r['idempotency_key'] as string,
    payload: r['payload'] as Record<string, unknown>,
  }
}

const toApproval = (r: Record<string, unknown>): Approval => ({
  id: r['id'] as string,
  mission_id: r['mission_id'] as string,
  task_id: r['task_id'] as string,
  action: r['action'] as string,
  scope: r['scope'] as Approval['scope'],
  requested_by: r['requested_by'] as string,
  risk_level: r['risk_level'] as RiskLevel,
  reason: r['reason'] as string,
  evidence_artifact_ids: (r['evidence_artifact_ids'] as string[]) ?? [],
  decision: r['decision'] as ApprovalDecision,
  decided_by: (r['decided_by'] as string | null) ?? null,
  decided_at: isoOrNull(r['decided_at']),
  expires_at: iso(r['expires_at']),
  created_at: iso(r['created_at']),
})

const toLock = (r: Record<string, unknown>): ResourceLock => ({
  lock_id: r['lock_id'] as string,
  resource: r['resource'] as string,
  task_id: r['task_id'] as string,
  mission_id: r['mission_id'] as string,
  holder_runner_id: r['holder_runner_id'] as string,
  acquired_at: iso(r['acquired_at']),
  expires_at: iso(r['expires_at']),
  released_at: isoOrNull(r['released_at']),
})

const toArtifact = (r: Record<string, unknown>): Artifact => ({
  artifact_id: r['artifact_id'] as string,
  mission_id: r['mission_id'] as string,
  task_id: r['task_id'] as string,
  role: r['role'] as string,
  uri: r['uri'] as string,
  media_type: r['media_type'] as string,
  size_bytes: Number(r['size_bytes']),
  sha256: r['sha256'] as string,
  version: Number(r['version']),
  state: r['state'] as Artifact['state'],
  producer: r['producer'] as Artifact['producer'],
  provenance: r['provenance'] as Record<string, unknown>,
  retention: r['retention'] as Artifact['retention'],
  security: r['security'] as Artifact['security'],
  created_at: iso(r['created_at']),
})

const toReview = (r: Record<string, unknown>): Review => ({
  id: r['id'] as string,
  mission_id: r['mission_id'] as string,
  reviewed_task_ids: (r['reviewed_task_ids'] as string[]) ?? [],
  round: Number(r['round']),
  decision: r['decision'] as Review['decision'],
  created_at: iso(r['created_at']),
})

// ------------------------------------------------------------- 实现

export interface PgStoreOptions {
  readonly connectionString: string
  /** 表所在 schema。测试用独立 schema 隔离，生产用 public。 */
  readonly schema?: string
}

export class PgStore implements Store {
  readonly #pool: pg.Pool
  readonly #schema: string
  #seq = 0

  constructor(opts: PgStoreOptions) {
    this.#schema = opts.schema ?? 'public'
    this.#pool = new Pool({
      connectionString: opts.connectionString,
      max: 8,
      // 显式超时：宁可明确失败，也不要静默挂起
      connectionTimeoutMillis: 10_000,
      idle_in_transaction_session_timeout: 30_000,
    })
    this.#pool.on('connect', (c) => {
      void c.query(`SET search_path TO ${this.#schema}`)
    })
  }

  /** 建表。幂等，可重复执行。 */
  async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url))
    const ddl = await readFile(join(here, 'pg-schema.sql'), 'utf8')
    const c = await this.#pool.connect()
    try {
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${this.#schema}`)
      await c.query(`SET search_path TO ${this.#schema}`)
      await c.query(ddl)
    } finally {
      c.release()
    }
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }

  async #tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.#pool.connect()
    try {
      await c.query('BEGIN')
      const out = await fn(c)
      await c.query('COMMIT')
      return out
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }
  }

  #nextId(prefix: string): string {
    this.#seq += 1
    return `${prefix}_${Date.now().toString(36)}_${String(this.#seq).padStart(6, '0')}`
  }

  /** 在给定事务内写事件。幂等冲突由唯一约束抛出，交给调用方处理。 */
  async #insertEvent(
    c: PoolClient,
    e: {
      missionId: string
      taskId: string | null
      type: EventType
      actor: EventActor
      idempotencyKey: string
      payload?: Record<string, unknown>
      causationId?: string | null
    },
  ): Promise<TaskEvent> {
    const { rows } = await c.query(
      `INSERT INTO events (
         event_id, event_type, event_version, occurred_at, mission_id, task_id,
         attempt, actor_type, actor_id, runner_id, causation_id, correlation_id,
         trace_id, lamport, idempotency_key, payload
       ) VALUES ($1,$2,1,now(),$3,$4,NULL,$5,$6,$7,$8,$9,NULL,nextval('lamport_seq'),$10,$11)
       RETURNING *`,
      [
        this.#nextId('evt'), e.type, e.missionId, e.taskId,
        e.actor.type, e.actor.id, e.actor.runner_id ?? null,
        e.causationId ?? null, e.missionId,
        e.idempotencyKey, JSON.stringify(e.payload ?? {}),
      ],
    )
    return toEvent(rows[0] as Record<string, unknown>)
  }

  // ---------------------------------------------------------- Mission

  async createMission(input: CreateMissionInput): Promise<Mission> {
    const m = input.mission
    return this.#tx(async (c) => {
      await c.query(
        `INSERT INTO missions (id, tenant, owner, type, goal, constraints, acceptance,
                               workflow_template, state, revision, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          m.id, m.tenant, m.owner, m.type, m.goal,
          JSON.stringify(m.constraints), JSON.stringify(m.acceptance),
          m.workflow_template, m.state, m.revision, m.created_at, m.updated_at,
        ],
      )
      await this.#insertEvent(c, {
        missionId: m.id, taskId: null, type: 'MISSION_CREATED',
        actor: input.actor, idempotencyKey: `mission-created:${m.id}`,
        payload: { goal: m.goal },
      })

      // 写入即回读校验，且在同一事务内——出问题整体回滚
      const { rows } = await c.query('SELECT * FROM missions WHERE id = $1', [m.id])
      if (rows.length !== 1) {
        throw new WriteVerificationError('Mission', m.id, '回读为空')
      }
      return toMission(rows[0] as Record<string, unknown>)
    })
  }

  async getMission(id: string): Promise<Mission | null> {
    const { rows } = await this.#pool.query('SELECT * FROM missions WHERE id = $1', [id])
    return rows.length ? toMission(rows[0] as Record<string, unknown>) : null
  }

  async setMissionState(id: string, state: MissionState, actor: EventActor): Promise<Mission> {
    return this.#tx(async (c) => {
      const { rows, rowCount } = await c.query(
        'UPDATE missions SET state = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [id, state],
      )
      if (rowCount === 0) throw new NotFoundError('Mission', id)

      await this.#insertEvent(c, {
        missionId: id, taskId: null,
        type: state === 'COMPLETED' ? 'MISSION_COMPLETED' : 'MISSION_ESCALATED',
        actor, idempotencyKey: `mission-state:${id}:${state}`, payload: { state },
      })
      return toMission(rows[0] as Record<string, unknown>)
    })
  }

  // ------------------------------------------------------------- Task

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const t = input.task
    return this.#tx(async (c) => {
      await c.query(
        `INSERT INTO tasks (id, mission_id, parent_task_id, supersedes_task_id, capability,
                            risk, state, attempt, max_attempts, lamport, envelope, result,
                            binding, deps, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          t.id, t.mission_id, t.parent_task_id, t.supersedes_task_id, t.capability,
          t.risk, t.state, t.attempt, t.max_attempts, t.lamport,
          JSON.stringify(t.envelope),
          t.result ? JSON.stringify(t.result) : null,
          t.binding ? JSON.stringify(t.binding) : null,
          t.deps, t.created_at, t.updated_at,
        ],
      )
      await this.#insertEvent(c, {
        missionId: t.mission_id, taskId: t.id, type: 'TASK_CREATED',
        actor: input.actor, idempotencyKey: `task-created:${t.id}`,
        payload: { capability: t.capability, risk: t.risk },
        causationId: input.causationId ?? null,
      })

      const { rows } = await c.query('SELECT * FROM tasks WHERE id = $1', [t.id])
      if (rows.length !== 1) throw new WriteVerificationError('Task', t.id, '回读为空')
      return toTask(rows[0] as Record<string, unknown>)
    })
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const { rows } = await this.#pool.query('SELECT * FROM tasks WHERE id = $1', [id])
    return rows.length ? toTask(rows[0] as Record<string, unknown>) : null
  }

  async transitionTask(input: TransitionTaskInput): Promise<TaskRecord> {
    return this.#tx(async (c) => {
      // 幂等去重最先做：重复投递应直接返回当前状态，否则会因
      // 「当前状态已是目标态」而被误判成非法迁移——重试反而报错。
      const dup = await c.query(
        'SELECT 1 FROM events WHERE idempotency_key = $1',
        [input.idempotencyKey],
      )
      if (dup.rowCount && dup.rowCount > 0) {
        const { rows } = await c.query('SELECT * FROM tasks WHERE id = $1', [input.taskId])
        if (!rows.length) throw new NotFoundError('Task', input.taskId)
        return toTask(rows[0] as Record<string, unknown>)
      }

      // 锁定任务行，防止并发迁移
      const cur = await c.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [input.taskId])
      if (!cur.rows.length) throw new NotFoundError('Task', input.taskId)

      const task = toTask(cur.rows[0] as Record<string, unknown>)

      if (input.expectedFrom !== undefined && task.state !== input.expectedFrom) {
        throw new ConcurrentModificationError(input.taskId, input.expectedFrom, task.state)
      }

      // 非法迁移在写入任何数据前抛出
      assertTransition(task.state, input.to)

      // 条件更新：即便持有行锁，也用 WHERE state 双保险
      const upd = await c.query(
        `UPDATE tasks SET state = $3, lamport = nextval('lamport_seq'), updated_at = now()
         WHERE id = $1 AND state = $2 RETURNING *`,
        [input.taskId, task.state, input.to],
      )
      if (upd.rowCount !== 1) {
        throw new ConcurrentModificationError(input.taskId, task.state, task.state)
      }

      await this.#insertEvent(c, {
        missionId: task.mission_id, taskId: task.id, type: input.eventType,
        actor: input.actor, idempotencyKey: input.idempotencyKey,
        payload: { from: task.state, to: input.to, ...(input.payload ?? {}) },
        causationId: input.causationId ?? null,
      })

      const back = toTask(upd.rows[0] as Record<string, unknown>)
      if (back.state !== input.to) {
        throw new WriteVerificationError('Task', task.id, `回读状态为 ${back.state}`)
      }
      return back
    })
  }

  async setTaskBinding(taskId: string, binding: RemoteTaskBinding): Promise<TaskRecord> {
    const { rows, rowCount } = await this.#pool.query(
      'UPDATE tasks SET binding = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [taskId, JSON.stringify(binding)],
    )
    if (rowCount === 0) throw new NotFoundError('Task', taskId)

    const back = toTask(rows[0] as Record<string, unknown>)
    if (back.binding?.remote_task_id !== binding.remote_task_id) {
      throw new WriteVerificationError('Task', taskId, 'binding 回读不符')
    }
    return back
  }

  async queryTasks(q: TaskQuery): Promise<readonly TaskRecord[]> {
    const where: string[] = []
    const args: unknown[] = []
    if (q.missionId) { args.push(q.missionId); where.push(`mission_id = $${args.length}`) }
    if (q.states?.length) { args.push(q.states); where.push(`state = ANY($${args.length})`) }
    if (q.capability) { args.push(q.capability); where.push(`capability = $${args.length}`) }

    let sql = 'SELECT * FROM tasks'
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY created_at'
    if (q.limit) { args.push(q.limit); sql += ` LIMIT $${args.length}` }

    const { rows } = await this.#pool.query(sql, args)
    return rows.map((r) => toTask(r as Record<string, unknown>))
  }

  async findReadyTasks(missionId: string): Promise<readonly TaskRecord[]> {
    // 依赖必须全部 COMPLETED。用 NOT EXISTS 表达「不存在未完成的依赖」，
    // 缺失的依赖同样算未满足——宁可不调度，也不能在依赖缺失时执行。
    const { rows } = await this.#pool.query(
      `SELECT t.* FROM tasks t
       WHERE t.mission_id = $1
         AND t.state = 'READY'
         AND NOT EXISTS (
           SELECT 1 FROM unnest(t.deps) AS dep_id
           WHERE NOT EXISTS (
             SELECT 1 FROM tasks d WHERE d.id = dep_id AND d.state = 'COMPLETED'
           )
         )
       ORDER BY t.created_at`,
      [missionId],
    )
    return rows.map((r) => toTask(r as Record<string, unknown>))
  }

  // ------------------------------------------------------------ Event

  async appendEvent(input: AppendEventInput): Promise<TaskEvent> {
    const e = input.event
    try {
      return await this.#tx((c) =>
        this.#insertEvent(c, {
          missionId: e.mission_id, taskId: e.task_id, type: e.event_type,
          actor: e.actor, idempotencyKey: e.idempotency_key,
          payload: e.payload as Record<string, unknown>,
          causationId: e.causation_id,
        }),
      )
    } catch (err) {
      // 幂等：唯一约束冲突说明同一 key 已写过，返回已有事件
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        const { rows } = await this.#pool.query(
          'SELECT * FROM events WHERE idempotency_key = $1',
          [e.idempotency_key],
        )
        if (rows.length) return toEvent(rows[0] as Record<string, unknown>)
      }
      throw err
    }
  }

  async listEvents(missionId: string): Promise<readonly TaskEvent[]> {
    const { rows } = await this.#pool.query(
      'SELECT * FROM events WHERE mission_id = $1 ORDER BY lamport',
      [missionId],
    )
    return rows.map((r) => toEvent(r as Record<string, unknown>))
  }

  async listUndeliveredEvents(limit: number): Promise<readonly TaskEvent[]> {
    const { rows } = await this.#pool.query(
      'SELECT * FROM events WHERE delivered_at IS NULL ORDER BY lamport LIMIT $1',
      [limit],
    )
    return rows.map((r) => toEvent(r as Record<string, unknown>))
  }

  async markEventDelivered(eventId: string): Promise<void> {
    await this.#pool.query(
      'UPDATE events SET delivered_at = now() WHERE event_id = $1',
      [eventId],
    )
  }

  // --------------------------------------------------------- Artifact

  async putArtifact(a: Artifact): Promise<Artifact> {
    const { rows } = await this.#pool.query(
      `INSERT INTO artifacts (artifact_id, mission_id, task_id, role, uri, media_type,
                              size_bytes, sha256, version, state, producer, provenance,
                              retention, security, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (artifact_id) DO UPDATE SET state = EXCLUDED.state
       RETURNING *`,
      [
        a.artifact_id, a.mission_id, a.task_id, a.role, a.uri, a.media_type,
        a.size_bytes, a.sha256, a.version, a.state,
        JSON.stringify(a.producer), JSON.stringify(a.provenance),
        JSON.stringify(a.retention), JSON.stringify(a.security), a.created_at,
      ],
    )
    return toArtifact(rows[0] as Record<string, unknown>)
  }

  async listArtifacts(taskId: string): Promise<readonly Artifact[]> {
    const { rows } = await this.#pool.query(
      'SELECT * FROM artifacts WHERE task_id = $1 ORDER BY created_at',
      [taskId],
    )
    return rows.map((r) => toArtifact(r as Record<string, unknown>))
  }

  // ----------------------------------------------------------- Review

  async putReview(r: Review): Promise<Review> {
    const { rows } = await this.#pool.query(
      `INSERT INTO reviews (id, mission_id, reviewed_task_ids, round, decision, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [r.id, r.mission_id, r.reviewed_task_ids, r.round, JSON.stringify(r.decision), r.created_at],
    )
    return toReview(rows[0] as Record<string, unknown>)
  }

  async listReviews(missionId: string): Promise<readonly Review[]> {
    const { rows } = await this.#pool.query(
      'SELECT * FROM reviews WHERE mission_id = $1 ORDER BY round',
      [missionId],
    )
    return rows.map((r) => toReview(r as Record<string, unknown>))
  }

  // --------------------------------------------------------- Approval

  async createApproval(a: Approval): Promise<Approval> {
    const { rows } = await this.#pool.query(
      `INSERT INTO approvals (id, mission_id, task_id, action, scope, requested_by,
                              risk_level, reason, evidence_artifact_ids, decision,
                              decided_by, decided_at, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        a.id, a.mission_id, a.task_id, a.action, a.scope, a.requested_by,
        a.risk_level, a.reason, a.evidence_artifact_ids, a.decision,
        a.decided_by, a.decided_at, a.expires_at, a.created_at,
      ],
    )
    return toApproval(rows[0] as Record<string, unknown>)
  }

  async decideApproval(
    id: string,
    decision: ApprovalDecision,
    decidedBy: string,
    at: string,
  ): Promise<Approval> {
    const { rows, rowCount } = await this.#pool.query(
      `UPDATE approvals SET decision = $2, decided_by = $3, decided_at = $4
       WHERE id = $1 RETURNING *`,
      [id, decision, decidedBy, at],
    )
    if (rowCount === 0) throw new NotFoundError('Approval', id)
    return toApproval(rows[0] as Record<string, unknown>)
  }

  async listPendingApprovals(missionId?: string): Promise<readonly Approval[]> {
    const sql = missionId
      ? `SELECT * FROM approvals WHERE decision = 'pending' AND mission_id = $1 ORDER BY created_at`
      : `SELECT * FROM approvals WHERE decision = 'pending' ORDER BY created_at`
    const { rows } = await this.#pool.query(sql, missionId ? [missionId] : [])
    return rows.map((r) => toApproval(r as Record<string, unknown>))
  }

  // ----------------------------------------------------- Resource Lock

  async acquireLock(lock: ResourceLock): Promise<ResourceLock> {
    return this.#tx(async (c) => {
      // 把同一 resource 的获取串行化。
      // 只用 SELECT ... FOR UPDATE 不够：没有匹配行时它不阻塞，
      // 两个并发请求会双双查空然后都插入。
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lock.resource])

      const held = await c.query(
        `SELECT * FROM resource_locks
         WHERE resource = $1 AND released_at IS NULL AND expires_at > now()`,
        [lock.resource],
      )
      if (held.rows.length) {
        const h = toLock(held.rows[0] as Record<string, unknown>)
        throw new LockUnavailableError(lock.resource, h.task_id)
      }

      const { rows } = await c.query(
        `INSERT INTO resource_locks (lock_id, resource, task_id, mission_id,
                                     holder_runner_id, acquired_at, expires_at, released_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL) RETURNING *`,
        [
          lock.lock_id, lock.resource, lock.task_id, lock.mission_id,
          lock.holder_runner_id, lock.acquired_at, lock.expires_at,
        ],
      )
      return toLock(rows[0] as Record<string, unknown>)
    })
  }

  async renewLock(lockId: string, newExpiresAt: string): Promise<boolean> {
    return this.#tx(async (c) => {
      const cur = await c.query('SELECT * FROM resource_locks WHERE lock_id = $1 FOR UPDATE', [lockId])
      if (!cur.rows.length) return false

      const l = toLock(cur.rows[0] as Record<string, unknown>)
      if (l.released_at !== null) return false

      // 与抢占竞争：同一 resource 上锁的判定必须串行，
      // 否则可能出现「抢占成功」与「续租成功」同时返回真。
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [l.resource])

      const taken = await c.query(
        `SELECT 1 FROM resource_locks
         WHERE resource = $1 AND lock_id <> $2
           AND released_at IS NULL AND expires_at > now()`,
        [l.resource, lockId],
      )
      if (taken.rowCount && taken.rowCount > 0) return false

      const upd = await c.query(
        'UPDATE resource_locks SET expires_at = $2 WHERE lock_id = $1 AND released_at IS NULL',
        [lockId, newExpiresAt],
      )
      return upd.rowCount === 1
    })
  }

  async releaseLock(lockId: string, at: string): Promise<void> {
    const { rowCount } = await this.#pool.query(
      'UPDATE resource_locks SET released_at = $2 WHERE lock_id = $1',
      [lockId, at],
    )
    if (rowCount === 0) throw new NotFoundError('ResourceLock', lockId)
  }

  async listActiveLocks(now: string): Promise<readonly ResourceLock[]> {
    const { rows } = await this.#pool.query(
      `SELECT * FROM resource_locks
       WHERE released_at IS NULL AND expires_at > $1 ORDER BY acquired_at`,
      [now],
    )
    return rows.map((r) => toLock(r as Record<string, unknown>))
  }

  // ------------------------------------------------------------ 自检

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const { rows } = await this.#pool.query(
        'SELECT (SELECT count(*) FROM missions) AS m, (SELECT count(*) FROM tasks) AS t',
      )
      const r = rows[0] as { m: string; t: string }
      return { ok: true, detail: `missions=${r.m} tasks=${r.t}` }
    } catch (e) {
      return { ok: false, detail: String(e) }
    }
  }
}
