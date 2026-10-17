/**
 * Mission 效率与路由报表（实施计划 S0.0 / S0.4，只读账本）。
 *
 * 每个 Mission：状态、端到端耗时、任务数、返工轮次、是否一次通过、tokens 与 Agent 耗时（task-result.cost），
 * 是否带 Memross 记忆（constraints.memory）；派发路由：首选命中、回落、决策耗时、排队等待（TASK_READY→TASK_STARTED）。
 * 汇总按「带记忆 / 不带记忆」分组，供上手效率对照。只输出关联 ID 与数值，不输出目标与证据正文。
 *
 * 用法：node scripts/mission-report.mjs [--tenant team-ycc] [--since 2026-10-01] [--json]
 */
const { PgStore } = await import('#domain-model')

const argAfter = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined }
const tenant = argAfter('--tenant') ?? 'team-ycc'
const since = argAfter('--since') ?? '1970-01-01'
const store = new PgStore({
  connectionString: process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap',
  schema: process.env['CMAP_DB_SCHEMA'] ?? 'public',
})

const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null)
const pct = (values, p) => { const s = values.filter((v) => v !== null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }

const rows = []
for (const mission of await store.queryMissions({ tenant })) {
  if (mission.created_at < since) continue
  const tasks = await store.queryTasks({ missionId: mission.id })
  const events = await store.listEvents(mission.id)
  const first = (type, taskId) => events.find((e) => e.event_type === type && (!taskId || e.task_id === taskId))?.occurred_at ?? null
  const terminal = events.find((e) => ['MISSION_COMPLETED', 'MISSION_FAILED', 'MISSION_ESCALATED'].includes(e.event_type))
  const routing = events.filter((e) => e.event_type === 'ROUTING_DECIDED').map((e) => e.payload)
  rows.push({
    mission_id: mission.id,
    state: mission.state,
    with_memory: Boolean(mission.constraints?.memory),
    template: mission.workflow_template,
    duration_ms: ms(mission.created_at, terminal?.occurred_at),
    tasks: tasks.length,
    rework_rounds: tasks.filter((t) => t.supersedes_task_id).length,
    first_pass: mission.state === 'COMPLETED' && !tasks.some((t) => t.supersedes_task_id),
    tokens: tasks.reduce((sum, t) => sum + (t.result?.cost?.tokens ?? 0), 0) || null,
    agent_seconds: tasks.reduce((sum, t) => sum + (t.result?.cost?.duration_seconds ?? 0), 0) || null,
    queue_wait_ms: tasks.map((t) => ms(first('TASK_READY', t.id), first('TASK_STARTED', t.id))).filter((v) => v !== null),
    routing: routing.map((r) => ({ chosen: r.chosen_agent, preferred: r.preferred_agent, fallback: r.fallback, decision_ms: r.decision_ms, reasons: r.candidates.filter((c) => c.verdict === 'skipped').map((c) => c.reason) })),
  })
}
await store.close()

const summarize = (group) => {
  const done = group.filter((r) => ['COMPLETED', 'FAILED', 'ESCALATED'].includes(r.state))
  const routing = group.flatMap((r) => r.routing)
  const preferredCases = routing.filter((r) => r.preferred)
  return {
    missions: group.length,
    completed_rate: done.length ? Math.round((group.filter((r) => r.state === 'COMPLETED').length / done.length) * 1000) / 10 : null,
    first_pass_rate: done.length ? Math.round((group.filter((r) => r.first_pass).length / done.length) * 1000) / 10 : null,
    duration_ms_p50: pct(group.map((r) => r.duration_ms), 0.5),
    tokens_p50: pct(group.map((r) => r.tokens), 0.5),
    agent_seconds_p50: pct(group.map((r) => r.agent_seconds), 0.5),
    queue_wait_ms_p95: pct(group.flatMap((r) => r.queue_wait_ms), 0.95),
    routing_decisions: routing.length,
    preferred_hit_rate: preferredCases.length ? Math.round((preferredCases.filter((r) => r.chosen === r.preferred).length / preferredCases.length) * 1000) / 10 : null,
    fallback_reasons: routing.flatMap((r) => r.reasons).reduce((acc, reason) => ({ ...acc, [reason]: (acc[reason] ?? 0) + 1 }), {}),
    decision_ms_p95: pct(routing.map((r) => r.decision_ms), 0.95),
    no_route: routing.filter((r) => !r.chosen).length,
  }
}
const report = { tenant, since, with_memory: summarize(rows.filter((r) => r.with_memory)), without_memory: summarize(rows.filter((r) => !r.with_memory)) }
console.log(JSON.stringify(process.argv.includes('--json') ? { ...report, rows } : report, null, 2))
