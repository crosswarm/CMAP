import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Approval,
  Artifact,
  ControlPlaneContextV1,
  EvidencePack,
  Mission,
  QuotaHandoffV1,
  QuotaSnapshotV1,
  ResourceLock,
  Review,
  TaskRecord,
} from '#domain-model'
import { request, post, subscribe } from './api.ts'
import {
  acceptanceRows,
  attentionState,
  type MissionListItem,
  dagNodeRows,
  needsAction,
  missionDisplayState,
  operatorLabels,
  showTime,
  showValue,
  stateTone,
  statusLabels,
} from './presentation.ts'
import { ApprovalDialog, ArtifactDialog, CreateMission } from './dialogs.tsx'

type View = 'missions' | 'approvals' | 'resources'
interface Detail {
  mission: Mission
  tasks: TaskRecord[]
  reviews: Review[]
  evidence: EvidencePack
  handoffs: QuotaHandoffV1[]
}
type Modal =
  | { type: 'create' }
  | { type: 'approval'; value: Approval }
  | { type: 'artifact'; value: Artifact }
  | null
const locationState = () => {
  const params = new URLSearchParams(location.hash.slice(1))
  const view = params.get('view')
  return {
    view: (['missions', 'approvals', 'resources'].includes(view ?? '')
      ? view
      : 'missions') as View,
    mission: params.get('mission'),
  }
}
const navigate = (view: View, mission: string | null) => {
  const params = new URLSearchParams({ view })
  if (mission) params.set('mission', mission)
  location.hash = params.toString()
}
const Icon = ({ name }: { name: 'missions' | 'approvals' | 'resources' }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
    <path
      d={
        name === 'missions'
          ? 'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5'
          : name === 'approvals'
            ? 'M12 3l8 4v6c0 4-8 8-8 8s-8-4-8-8V7z M8 12l3 3 5-6'
            : 'M4 4h16v6H4z M4 14h16v6H4z M7 7h1 M7 17h1'
      }
    />
  </svg>
)
const Badge = ({ state }: { state: string }) => (
  <span className={`badge ${stateTone(state)}`}>
    {statusLabels[state] ?? state}
  </span>
)

export default function App() {
  const [navigation, setNavigation] = useState(locationState)
  const [context, setContext] = useState<ControlPlaneContextV1 | null>(null)
  const [missions, setMissions] = useState<MissionListItem[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [locks, setLocks] = useState<ResourceLock[]>([])
  const [quota, setQuota] = useState<QuotaSnapshotV1[]>([])
  const [detail, setDetail] = useState<Detail | null>(null)
  const [taskSummaries, setTaskSummaries] = useState<
    Record<string, TaskRecord[]>
  >({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [connection, setConnection] = useState<
    'connecting' | 'connected' | 'reconnecting'
  >('connecting')
  const [modal, setModal] = useState<Modal>(null)
  const [tab, setTab] = useState<'acceptance' | 'evidence' | 'rework'>(
    'acceptance',
  )
  const [updated, setUpdated] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const startPending = useRef(false)
  const activeRequest = useRef<AbortController | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    const onHash = () => {
      setNavigation(locationState())
      setTab('acceptance')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const refresh = useCallback(async () => {
    const current = ++generation.current
    activeRequest.current?.abort()
    const abort = new AbortController()
    activeRequest.current = abort
    setLoading(true)
    const options = { signal: abort.signal }
    try {
      const id = navigation.mission
      const loadDetail = async (): Promise<Detail | null> => {
        if (!id) return null
        const path = `/v1/missions/${encodeURIComponent(id)}`
        const [mission, tasks, reviews, evidence, handoffs] = await Promise.all([
          request<Mission>(path, options),
          request<{ items: TaskRecord[] }>(`${path}/tasks`, options),
          request<{ items: Review[] }>(`${path}/reviews`, options),
          request<EvidencePack>(`${path}/evidence`, options),
          request<{ items: QuotaHandoffV1[] }>(`${path}/quota-handoffs`, options),
        ])
        return { mission, tasks: tasks.items, reviews: reviews.items, evidence, handoffs: handoffs.items }
      }
      const [ctx, list, pending, activeLocks, snapshots, selected] = await Promise.all([
        request<ControlPlaneContextV1>('/v1/context', options),
        request<{ items: MissionListItem[] }>('/v1/missions', options),
        request<{ items: Approval[] }>('/v1/approvals', options),
        request<{ items: ResourceLock[] }>('/v1/locks', options),
        request<{ items: QuotaSnapshotV1[] }>('/v1/quota-snapshots', options),
        loadDetail(),
      ])
      // 只有选中的 Mission 拉任务；其余 RUNNING Mission 的侧栏状态取列表自带的 attention 摘要。
      const summaries: Record<string, TaskRecord[]> = {}
      if (selected) summaries[selected.mission.id] = selected.tasks
      if (current !== generation.current) return
      setContext(ctx)
      setMissions(
        [...list.items].sort(
          (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
        ),
      )
      setApprovals(pending.items)
      setLocks(activeLocks.items)
      setQuota(snapshots.items)
      setDetail(selected)
      setTaskSummaries(summaries)
      setError('')
      setUpdated(new Date().toISOString())
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : '数据加载失败')
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [navigation.mission])
  const reload = useRef(refresh)
  useEffect(() => {
    reload.current = refresh
    void refresh()
    return () => activeRequest.current?.abort()
  }, [refresh])
  useEffect(() => {
    const seen = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const close = subscribe('/v1/events', {
      open: () => setConnection('connected'),
      error: () => setConnection('reconnecting'),
      event: (raw) => {
      try {
        const data: unknown = JSON.parse(raw)
        if (
          !data ||
          typeof data !== 'object' ||
          !('event_id' in data) ||
          typeof data.event_id !== 'string' ||
          seen.has(data.event_id)
        )
          return
        seen.add(data.event_id)
        if (!timer)
          timer = setTimeout(() => {
            timer = undefined
            void reload.current()
          }, 200)
      } catch {
        setConnection('reconnecting')
      }
      },
    })
    return () => {
      close()
      clearTimeout(timer)
    }
  }, [])

  const selected = detail?.mission.id === navigation.mission ? detail : null
  const visible = missions.filter((m) =>
    `${m.goal} ${m.id} ${statusLabels[m.state]}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const displayState = (mission: MissionListItem) =>
    mission.state === 'RUNNING' && !taskSummaries[mission.id]
      ? (attentionState(mission.attention) ?? mission.state)
      : missionDisplayState(mission, taskSummaries[mission.id] ?? [])
  const groups = [
    {
      label: '需要你处理',
      items: visible.filter((m) => needsAction(displayState(m))),
      attention: true,
    },
    {
      label: '进行与等待',
      items: visible.filter(
        (m) =>
          !needsAction(displayState(m)) &&
          !['COMPLETED', 'CANCELED'].includes(m.state),
      ),
      attention: false,
    },
    {
      label: '已结束',
      items: visible.filter((m) => ['COMPLETED', 'CANCELED'].includes(m.state)),
      attention: false,
    },
  ]
  const currentPending = approvals.filter(
    (a) => a.mission_id === navigation.mission,
  )
  const rows = selected
    ? acceptanceRows(selected.mission, selected.tasks, selected.reviews)
    : []
  const dagRows = selected
    ? dagNodeRows(selected.mission, selected.tasks, selected.reviews)
    : []
  const openApproval = (value: Approval) =>
    setModal({ type: 'approval', value })
  const resumeStart = async () => {
    if (!selected || startPending.current) return
    startPending.current = true
    setStarting(true)
    try {
      await post(
        `/v1/missions/${encodeURIComponent(selected.mission.id)}/start`,
        {},
      )
      await refresh()
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : '启动未确认，可再次重试此目标',
      )
    } finally {
      startPending.current = false
      setStarting(false)
    }
  }

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
      >
        跳到主内容
      </a>
      <aside className="rail" aria-label="主导航">
        <a href="#view=missions" className="brand" aria-label="CMAP 工作台">
          <span className="brand-mark">C</span>
          <strong>CMAP</strong>
        </a>
        <nav>
          {(['missions', 'approvals', 'resources'] as const).map((view) => (
            <button
              key={view}
              className={`nav-item ${navigation.view === view ? 'active' : ''}`}
              aria-current={navigation.view === view ? 'page' : undefined}
              onClick={() => navigate(view, navigation.mission)}
            >
              <Icon name={view} />
              <span>
                {
                  { missions: '任务', approvals: '审批', resources: '资源' }[
                    view
                  ]
                }
              </span>
              {view === 'approvals' && approvals.length > 0 && (
                <span className="nav-count">{approvals.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div
          className="local-mode"
          title={context?.authentication === 'oidc' ? `已登录：${context.owner}` : '本机模式，尚未接入身份认证'}
        >
          <span className="operator-avatar">
            {context?.owner?.slice(0, 1).toUpperCase() ?? '·'}
          </span>
          <span>{context?.authentication === 'oidc' ? '已登录' : '本机'}</span>
        </div>
      </aside>

      <aside className="mission-sidebar" aria-label="任务队列">
        <header className="sidebar-heading">
          <h1>任务队列</h1>
          <span className="count">{missions.length}</span>
        </header>
        <div className="sidebar-controls">
          <label className="search">
            <span className="sr-only">搜索任务</span>
            <input
              type="search"
              placeholder="搜索目标或编号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button
            className="primary create-button"
            onClick={() => setModal({ type: 'create' })}
          >
            ＋ 新建目标
          </button>
        </div>
        <div className="mission-groups">
          {loading && missions.length === 0 ? (
            <p className="sidebar-empty" role="status">
              正在载入任务…
            </p>
          ) : error && missions.length === 0 ? (
            <p className="sidebar-empty">任务列表未能载入</p>
          ) : visible.length === 0 ? (
            <p className="sidebar-empty">
              {query
                ? '没有匹配的任务'
                : '还没有任务。从一个可验收的目标开始。'}
            </p>
          ) : (
            groups
              .filter((g) => g.items.length)
              .map((group) => (
                <section key={group.label} className="mission-group">
                  <h2 className={group.attention ? 'attention-text' : ''}>
                    {group.label}
                    <span>{group.items.length}</span>
                  </h2>
                  {group.items.map((mission) => (
                    <button
                      key={mission.id}
                      className={`mission-item ${navigation.mission === mission.id ? 'selected' : ''}`}
                      onClick={() => navigate('missions', mission.id)}
                      aria-pressed={navigation.mission === mission.id}
                    >
                      <strong>{mission.goal}</strong>
                      <Badge state={displayState(mission)} />
                      <span className="mission-meta">
                        {showTime(mission.updated_at)}
                        <span>{mission.id.slice(-8)}</span>
                      </span>
                    </button>
                  ))}
                </section>
              ))
          )}
        </div>
        <footer className="sidebar-footer">
          <span>{context?.tenant ?? '正在连接'}</span>
          <button
            className="text-button"
            disabled={loading}
            onClick={() => {
              void refresh()
            }}
          >
            刷新
          </button>
        </footer>
      </aside>

      <main id="main-content" tabIndex={-1} className="workspace">
        <header className="topbar">
          <span>
            CMAP /{' '}
            {
              {
                missions: '验收工作台',
                approvals: '审批中心',
                resources: '资源与执行端',
              }[navigation.view]
            }
          </span>
          <div className="connection-state" role="status">
            <span className={`connection-dot ${connection}`} />
            {connection === 'connected'
              ? '实时已连接'
              : connection === 'connecting'
                ? '正在连接'
                : '连接中断，正在重连'}
          </div>
        </header>
        {error && (
          <div role="alert" className="page-error">
            <strong>无法更新数据</strong>
            <span>{error}</span>
            <button
              className="secondary"
              onClick={() => {
                void refresh()
              }}
            >
              重试
            </button>
          </div>
        )}
        {navigation.view === 'approvals' ? (
          <>
            <header className="page-heading">
              <div>
                <h1 id="workspace-title" tabIndex={-1}>
                  审批中心
                </h1>
                <p>分别处理每一种授权。一次决定只影响一项请求。</p>
              </div>
              <span className="total-pending">{approvals.length} 项待处理</span>
            </header>
            <div className="approval-columns">
              {(['controlled', 'mutating'] as const).map((scope) => (
                <section className={`approval-column ${scope}`} key={scope}>
                  <header>
                    <h2>
                      {scope === 'controlled'
                        ? '受控副作用'
                        : '代码 / 配置变更'}
                    </h2>
                    <code>{scope}</code>
                  </header>
                  {approvals.filter((a) => a.scope === scope).length === 0 ? (
                    <div className="empty-compact">没有待处理请求</div>
                  ) : (
                    approvals
                      .filter((a) => a.scope === scope)
                      .map((a) => (
                        <article className="approval-card" key={a.id}>
                          <span className="badge attention">待审批</span>
                          <h3>
                            {missions.find((m) => m.id === a.mission_id)
                              ?.goal ?? a.mission_id}
                          </h3>
                          <p>{a.reason}</p>
                          <dl>
                            <dt>请求动作</dt>
                            <dd>{a.action}</dd>
                            <dt>截止</dt>
                            <dd>{showTime(a.expires_at)}</dd>
                          </dl>
                          <button
                            className="secondary"
                            onClick={() => openApproval(a)}
                          >
                            查看并决定 {scope}
                          </button>
                        </article>
                      ))
                  )}
                </section>
              ))}
            </div>
          </>
        ) : navigation.view === 'resources' ? (
          <>
            <header className="page-heading">
              <div>
                <h1 id="workspace-title" tabIndex={-1}>
                  资源与执行端
                </h1>
                <p>以实际资源锁和任务绑定为准，不推测队列位置或完成时间。</p>
              </div>
            </header>
            <section className="panel">
              <div className="section-title">
                <h2>当前资源占用</h2>
                <span>{locks.length} 个有效锁</span>
              </div>
              {locks.length === 0 ? (
                <div className="empty-compact">当前没有资源锁</div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>资源</th>
                        <th>占用任务</th>
                        <th>执行端</th>
                        <th>到期时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {locks.map((lock) => (
                        <tr key={lock.lock_id}>
                          <td>{lock.resource}</td>
                          <td className="identifier">{lock.task_id}</td>
                          <td>{lock.holder_runner_id}</td>
                          <td>{showTime(lock.expires_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="panel">
              <div className="section-title">
                <h2>账号额度</h2>
                <span>各账号最新快照，派发前据此跳过额度低的 Agent</span>
              </div>
              {quota.length === 0 ? (
                <div className="empty-compact">尚无额度快照</div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>提供方</th>
                        <th>账号摘要</th>
                        <th>窗口用量</th>
                        <th>允许普通用量</th>
                        <th>观测时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quota.map((q) => (
                        <tr key={`${q.provider}:${q.account_ref}`}>
                          <td>{q.provider}</td>
                          <td className="identifier">{q.account_ref?.slice(0, 12)}</td>
                          <td>
                            {q.status !== 'ok'
                              ? q.status === 'error' ? '读取出错' : '未知'
                              : q.windows.map((w) => (
                                  <span className="cell-note" key={w.kind}>
                                    {w.kind} {w.used_percent}%
                                    {w.resets_at ? ` · ${showTime(w.resets_at)} 重置` : ''}
                                  </span>
                                ))}
                          </td>
                          <td>{q.ordinary_usage_allowed === null ? '未说明' : q.ordinary_usage_allowed ? '是' : '否'}</td>
                          <td>{showTime(q.observed_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="panel">
              <div className="section-title">
                <h2>所选目标的执行绑定</h2>
              </div>
              {!selected || selected.tasks.every((t) => !t.binding) ? (
                <div className="empty-compact">
                  选择已派发的任务后，可查看实际执行端。
                </div>
              ) : (
                selected.tasks
                  .filter((t) => t.binding)
                  .map((task) => (
                    <div className="binding-row" key={task.id}>
                      <span className="identifier">{task.id}</span>
                      <strong>{task.binding!.adapter}</strong>
                      <span>{task.binding!.runner_id}</span>
                      <Badge state={task.state} />
                      <span className="muted">健康状态未提供</span>
                    </div>
                  ))
              )}
            </section>
          </>
        ) : !selected ? (
          <section className="welcome">
            <div className="welcome-symbol">◎</div>
            <h1 id="workspace-title" tabIndex={-1}>
              {loading && navigation.mission
                ? '正在读取目标…'
                : missions.length
                  ? '选择一个目标，查看验收依据'
                  : '把目标交给系统，把依据留给你'}
            </h1>
            <p>
              {missions.length
                ? '从左侧任务队列进入目标，查看执行进度、证据与审批。'
                : '创建目标并写清验收标准。执行、返工和证据会汇集到这里。'}
            </p>
            {!missions.length && !loading && !error && (
              <button
                className="primary"
                onClick={() => setModal({ type: 'create' })}
              >
                新建第一个目标
              </button>
            )}
          </section>
        ) : (
          <>
            <header className="page-heading mission-heading">
              <div>
                <div className="title-with-status">
                  <h1 id="workspace-title" tabIndex={-1}>
                    {selected.mission.goal}
                  </h1>
                  <Badge state={selected.mission.state} />
                </div>
                <div className="mission-facts">
                  <span>归属 {selected.mission.owner}</span>
                  <span>创建 {showTime(selected.mission.created_at)}</span>
                  <span className="identifier" title={selected.mission.id}>
                    {selected.mission.id.slice(-12)}
                  </span>
                </div>
              </div>
            </header>
            {selected.mission.state === 'ESCALATED' && (
              <div className="attention-banner">
                <strong>需要你介入</strong>
                <span>
                  自动返工已停止。请查看返工记录中的停止原因和未通过标准。
                </span>
              </div>
            )}
            {selected.mission.state === 'DRAFT' && (
              <div className="info-banner">
                <strong>目标已登记</strong>
                <span>尚未开始执行，可继续启动同一目标，不会重复创建。</span>
                <button
                  className="secondary"
                  disabled={
                    starting || selected.mission.owner !== context?.owner
                  }
                  onClick={() => {
                    void resumeStart()
                  }}
                >
                  {starting ? '启动中…' : '继续启动'}
                </button>
              </div>
            )}
            {selected.mission.state === 'COMPLETED' &&
              rows.some(
                (row) => row.state === 'failed' || row.state === 'unanswered',
              ) && (
                <div role="alert" className="page-error">
                  账本标记已完成，但当前验收数据存在不一致。请核对原始证据。
                </div>
              )}
            {selected.tasks.some((t) => t.state === 'WAITING_RESOURCE') && (
              <div className="info-banner">
                <strong>正常等待资源</strong>
                <span>无需操作；资源可用后系统继续执行。</span>
              </div>
            )}
            {currentPending.length > 0 && (
              <div className="attention-banner">
                <strong>{currentPending.length} 项授权等待你处理</strong>
                <span>批准当前范围后，对应任务才会继续。</span>
                <button
                  className="secondary"
                  onClick={() => navigate('approvals', navigation.mission)}
                >
                  查看审批
                </button>
              </div>
            )}
            <nav className="view-tabs" aria-label="目标详情视图">
              {(['acceptance', 'evidence', 'rework'] as const).map((view) => (
                <button
                  key={view}
                  className={tab === view ? 'active' : ''}
                  aria-current={tab === view ? 'page' : undefined}
                  onClick={() => setTab(view)}
                >
                  {
                    {
                      acceptance: '验收标准',
                      evidence: '证据与来源',
                      rework: '执行与返工',
                    }[view]
                  }
                </button>
              ))}
            </nav>
            {tab === 'acceptance' ? (
              <>
                <section className="panel acceptance-panel">
                  <div className="section-title">
                    <h2>逐项验收</h2>
                    <span className="muted">结论必须有对应结果与评审</span>
                  </div>
                  <div className="table-scroll">
                    <table className="acceptance-table">
                      <thead>
                        <tr>
                          <th>标准 / 指标</th>
                          <th>期望</th>
                          <th>实际结果</th>
                          <th>判定</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.criterion.criterion_id}>
                            <td>
                              <strong>{row.criterion.criterion_id}</strong>
                              <span className="cell-note">
                                {row.criterion.metric}
                              </span>
                              {'nodeId' in row && typeof row.nodeId === 'string' && row.nodeId && (
                                <span className="cell-note">
                                  节点 {row.nodeId}
                                </span>
                              )}
                            </td>
                            <td>
                              {operatorLabels[row.criterion.operator]}{' '}
                              <strong>
                                {showValue(row.criterion.expected)}
                              </strong>
                              {row.criterion.unit
                                ? ` ${row.criterion.unit}`
                                : ''}
                            </td>
                            <td>
                              {showValue(row.actual)}
                              {row.previousRound && (
                                <span className="cell-note">
                                  上轮结果，当前轮尚未交回
                                </span>
                              )}
                            </td>
                            <td>
                              <span
                                className={`badge ${row.state === 'passed' ? 'success' : row.state === 'failed' || row.state === 'unanswered' ? 'danger' : 'neutral'}`}
                              >
                                {
                                  {
                                    pending: '待核验',
                                    unanswered: '未回应',
                                    passed: '通过',
                                    failed: '未达标',
                                  }[row.state]
                                }
                              </span>
                              {row.reason && (
                                <span className="cell-note reason">
                                  {row.reason}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
                {dagRows.length > 0 && (
                  <section className="panel">
                    <div className="section-title">
                      <h2>DAG 节点</h2>
                      <span className="muted">按计划节点归集任务与依赖</span>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>节点</th>
                            <th>依赖</th>
                            <th>状态</th>
                            <th>尝试</th>
                            <th>执行端</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dagRows.map((row) => (
                            <tr key={row.nodeId}>
                              <td>
                                <strong>{row.nodeId}</strong>
                                <span className="cell-note">{row.goal}</span>
                              </td>
                              <td>{row.deps.length ? row.deps.join('、') : '—'}</td>
                              <td><Badge state={row.status} /></td>
                              <td>
                                {row.attempt ? `第 ${row.attempt} 轮` : '尚未生成'}
                                {row.taskId && (
                                  <span className="cell-note identifier">
                                    {row.taskId}
                                  </span>
                                )}
                              </td>
                              <td>{row.agent}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
                <section className="panel">
                  <div className="section-title">
                    <h2>当前执行</h2>
                    <button
                      className="text-button"
                      onClick={() => setTab('rework')}
                    >
                      查看完整任务链
                    </button>
                  </div>
                  <TaskList tasks={selected.tasks.slice(-3)} handoffs={selected.handoffs} />
                </section>
              </>
            ) : tab === 'evidence' ? (
              <section className="panel">
                <div className="section-title">
                  <h2>证据目录</h2>
                  <span className="muted">打开文件时重新核对哈希</span>
                </div>
                {selected.evidence.tasks.every((t) => !t.artifacts.length) ? (
                  <div className="empty-compact">
                    尚未交回证据。任务完成后在这里核对原始文件。
                  </div>
                ) : (
                  selected.evidence.tasks.map(
                    (task) =>
                      task.artifacts.length > 0 && (
                        <div className="evidence-group" key={task.taskId}>
                          <h3 className="identifier">{task.taskId}</h3>
                          {task.artifacts.map((artifact) => (
                            <article
                              className="artifact-row"
                              key={artifact.artifact_id}
                            >
                              <div className="file-mark">文</div>
                              <div className="artifact-info">
                                <strong>{artifact.role}</strong>
                                <span>{artifact.uri.split('/').at(-1)}</span>
                                <code title={artifact.sha256}>
                                  sha256 {artifact.sha256.slice(0, 20)}…
                                </code>
                              </div>
                              <span className="muted">
                                {artifact.size_bytes.toLocaleString()} B
                              </span>
                              <button
                                className="secondary"
                                onClick={() =>
                                  setModal({
                                    type: 'artifact',
                                    value: artifact,
                                  })
                                }
                              >
                                查看证据
                              </button>
                            </article>
                          ))}
                        </div>
                      ),
                  )
                )}
                {selected.evidence.edges.length > 0 && (
                  <div className="lineage">
                    <h3>证据血缘</h3>
                    {selected.evidence.edges.map((edge, index) => (
                      <p key={index}>
                        <code>{edge.source_artifact_id}</code>
                        <span>
                          {edge.relation === 'DERIVED_FROM' ? '派生自' : '取代'}
                        </span>
                        <code>{edge.target_artifact_id}</code>
                      </p>
                    ))}
                  </div>
                )}
              </section>
            ) : (
              <>
                <section className="panel">
                  <div className="section-title">
                    <h2>任务链</h2>
                    <span className="muted">
                      {selected.tasks.length} 个任务 · 返工预算{' '}
                      {String(
                        selected.mission.constraints['max_additional_cycles'] ??
                          '未指定',
                      )}
                    </span>
                  </div>
                  <TaskList tasks={selected.tasks} handoffs={selected.handoffs} />
                </section>
                {selected.handoffs.length > 0 && (
                  <section className="panel">
                    <div className="section-title">
                      <h2>额度交接</h2>
                      <span className="muted">原 Agent 额度耗尽后的续接链路，不计入返工轮次</span>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>次序</th>
                            <th>节点</th>
                            <th>原任务 → 续接任务</th>
                            <th>触顶 Agent</th>
                            <th>工作区</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selected.handoffs.map((h) => (
                            <tr key={h.from_task_id}>
                              <td>第 {h.handoff_index} 次</td>
                              <td>{h.node_id}</td>
                              <td>
                                <span className="cell-note identifier">{h.from_task_id}</span>
                                <span className="cell-note identifier">→ {h.to_task_id}</span>
                              </td>
                              <td>
                                {h.from_agent}
                                <span className="cell-note">排除 {h.excluded_agents.join('、')}</span>
                              </td>
                              <td>
                                {h.workspace === 'snapshot' ? '原工作区快照' : '新工作区'}
                                {h.snapshot && (
                                  <span className="cell-note identifier">sha256 {h.snapshot.sha256.slice(0, 12)}</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
                <section className="panel">
                  <div className="section-title">
                    <h2>评审与停止原因</h2>
                  </div>
                  {!selected.reviews.length ? (
                    <div className="empty-compact">尚无评审记录</div>
                  ) : (
                    [...selected.reviews]
                      .sort((a, b) => b.round - a.round)
                      .map((review) => (
                        <article className="review-row" key={review.id}>
                          <div className="review-round">
                            第 {review.round} 轮
                          </div>
                          <div>
                            <div className="review-title">
                              <strong>
                                {
                                  {
                                    accept: '验收通过',
                                    rework: '派生新任务返工',
                                    escalate: '升级处理',
                                  }[review.decision.decision]
                                }
                              </strong>
                              <span className="muted">
                                {showTime(review.created_at)}
                              </span>
                            </div>
                            {review.decision.failed_criteria?.map((item) => (
                              <div
                                className="review-failure"
                                key={item.criterion_id}
                              >
                                <strong>{item.criterion_id}</strong>
                                <p>{item.reason}</p>
                                <span>
                                  期望 {item.expected}；实际 {item.actual}
                                </span>
                              </div>
                            ))}
                            {review.decision.no_progress?.detected && (
                              <p className="attention-text">已检测到无进展</p>
                            )}
                            {review.decision.escalation && (
                              <p className="attention-text">
                                {review.decision.escalation.reason}
                              </p>
                            )}
                          </div>
                        </article>
                      ))
                  )}
                </section>
              </>
            )}
          </>
        )}
        <footer className="workspace-footer">
          <span>
            {updated ? `最近核对 ${showTime(updated)}` : '等待首批数据'}
          </span>
          <span>{context?.authentication === 'oidc' ? 'OIDC 登录' : '本机模式'}</span>
        </footer>
      </main>
      {modal?.type === 'create' && (
        <CreateMission
          close={() => setModal(null)}
          created={(id) => {
            setModal(null)
            navigate('missions', id)
            void refresh()
          }}
        />
      )}
      {modal?.type === 'approval' && (
        <ApprovalDialog
          approval={modal.value}
          mission={missions.find((m) => m.id === modal.value.mission_id)}
          actor={context?.owner ?? null}
          close={() => setModal(null)}
          decided={() => {
            void refresh()
          }}
        />
      )}
      {modal?.type === 'artifact' && (
        <ArtifactDialog artifact={modal.value} close={() => setModal(null)} />
      )}
    </div>
  )
}

function TaskList({ tasks, handoffs = [] }: { tasks: TaskRecord[]; handoffs?: QuotaHandoffV1[] }) {
  if (!tasks.length)
    return <div className="empty-compact">目标已接收，尚未生成执行任务。</div>
  return (
    <div className="task-list">
      {[...tasks]
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((task, index) => (
          <article className="task-row" key={task.id}>
            <span className="task-order">{index + 1}</span>
            <div className="task-info">
              <strong>{task.capability}</strong>
              <span className="identifier">{task.id}</span>
              {task.supersedes_task_id && (
                <span className="cell-note">
                  {handoffs.some((h) => h.to_task_id === task.id) ? '额度续接自' : '返工自'}{' '}
                  {task.supersedes_task_id}
                </span>
              )}
              {task.deps.length > 0 && (
                <span className="cell-note">依赖 {task.deps.join('、')}</span>
              )}
              <span className="cell-note">
                {task.binding
                  ? `${task.binding.adapter} / ${task.binding.runner_id}`
                  : '尚未派发'}
              </span>
              {task.envelope.execution_policy?.model_policy ? (
                <span className="cell-note">
                  模型 {task.envelope.execution_policy.model_policy.model} ·
                  努力度 {task.envelope.execution_policy.model_policy.effort}
                  （已记录，未确认生效）·{' '}
                  {task.envelope.execution_policy.model_policy.source ===
                  'agent_default'
                    ? '继承默认'
                    : '任务覆盖'}
                </span>
              ) : (
                <span className="cell-note">模型策略未指定</span>
              )}
            </div>
            <Badge state={task.state} />
          </article>
        ))}
    </div>
  )
}
