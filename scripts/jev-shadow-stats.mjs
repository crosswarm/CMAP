/**
 * ADR-0007 影子模式一致率：读取账本里的 JEV_DECIDED 与对应审批的真人终态。
 * 只比较 approved/rejected（真人决定）；pending、expired 不计入比较。escalate 不算一致。
 *
 * 用法：CMAP_TENANT=... [CMAP_DATABASE_URL=...] [CMAP_DB_SCHEMA=...] node scripts/jev-shadow-stats.mjs
 */
import { pathToFileURL } from 'node:url'

export async function shadowAgreement(store, tenant) {
  const stats = { total: 0, compared: 0, agree: 0, jev_approve_human_reject: 0 }
  for (const event of await store.listTenantEvents(tenant)) {
    // 只统计审批决定；调度者的分配决定（ADR-0009 §4）与审批无从比较
    if (event.event_type !== 'JEV_DECIDED' || event.payload?.decision_type === 'routing') continue
    stats.total++
    const approval = await store.getApproval(event.payload?.subject?.approval_id)
    if (approval?.decision !== 'approved' && approval?.decision !== 'rejected') continue
    stats.compared++
    const outcome = event.payload.outcome
    if ((outcome === 'approve' && approval.decision === 'approved') || (outcome === 'reject' && approval.decision === 'rejected')) stats.agree++
    if (outcome === 'approve' && approval.decision === 'rejected') stats.jev_approve_human_reject++
  }
  return stats
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { PgStore } = await import('#domain-model')
  const store = new PgStore({
    connectionString: process.env['CMAP_DATABASE_URL'] ?? 'postgres://temporal:temporal@localhost:5433/cmap',
    schema: process.env['CMAP_DB_SCHEMA'] ?? 'public',
  })
  try {
    console.log(JSON.stringify(await shadowAgreement(store, process.env['CMAP_TENANT'] ?? process.env['RUNNER_TENANT'] ?? 'team-ycc'), null, 2))
  } finally {
    await store.close()
  }
}
