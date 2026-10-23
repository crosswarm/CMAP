import React, {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react'
import type {
  Approval,
  ApprovalAdviceV1,
  Artifact,
  JevDecisionV1,
  Mission,
} from '#domain-model'
import {
  ApiError,
  post,
  request,
  approvalURL,
  artifactURL,
} from './api.ts'
import { authHeaders, oidcEnabled } from './auth.ts'
import {
  approvalPayload,
  expectedValue,
  operatorLabels,
  showTime,
} from './presentation.ts'

export function Dialog({
  title,
  children,
  close,
  busy = false,
  wide = false,
}: {
  title: string
  children: ReactNode
  close: () => void
  busy?: boolean
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const dialog = ref.current!
    dialog.showModal()
    return () => {
      dialog.close()
      if (before?.isConnected) before.focus()
      else document.getElementById('workspace-title')?.focus()
    }
  }, [])
  useEffect(() => {
    if (ref.current?.open && document.activeElement === document.body)
      ref.current.focus()
  }, [busy, children])
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className={wide ? 'modal wide' : 'modal'}
      aria-labelledby="dialog-title"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const dialog = ref.current!
        const controls = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])',
          ),
        ].filter((el) => el.getClientRects().length > 0)
        const first = controls[0]
        const last = controls.at(-1)
        if (!first) {
          event.preventDefault()
          dialog.focus()
          return
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog)
        ) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
    >
      <header className="modal-heading">
        <h2 id="dialog-title">{title}</h2>
        <button
          className="icon-button"
          type="button"
          aria-label="关闭"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  )
}

interface CriterionDraft {
  id: string
  metric: string
  operator: keyof typeof operatorLabels
  type: 'number' | 'string' | 'boolean'
  value: string
}
const initialCriterion = (): CriterionDraft => ({
  id: 'C1',
  metric: '',
  operator: 'eq',
  type: 'number',
  value: '',
})

export function CreateMission({
  close,
  created,
}: {
  close: () => void
  created: (id: string) => void
}) {
  const [goal, setGoal] = useState('')
  const [risk, setRisk] = useState('read-meta')
  const [cycles, setCycles] = useState(2)
  const [criteria, setCriteria] = useState<CriterionDraft[]>([
    initialCriterion(),
  ])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [locked, setLocked] = useState(false)
  const [registeredId, setRegisteredId] = useState<string | null>(null)
  const inFlight = useRef(false)
  const submission = useRef<Record<string, unknown> | null>(null)
  const update = (index: number, patch: Partial<CriterionDraft>) =>
    setCriteria((items) =>
      items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    )
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (inFlight.current) return
    setError('')
    try {
      if (!submission.current) {
        if (!goal.trim()) throw new Error('请填写任务目标')
        if (new Set(criteria.map((c) => c.id.trim())).size !== criteria.length)
          throw new Error('验收标准编号不能重复')
        const acceptance = criteria.map((c) => {
          if (!c.id.trim() || !c.metric.trim())
            throw new Error('请填写验收标准编号和指标')
          return {
            criterion_id: c.id.trim(),
            metric: c.metric.trim(),
            operator: c.operator,
            expected: expectedValue(c.type, c.value),
            hard_gate: true,
          }
        })
        submission.current = {
          request_id: crypto.randomUUID(),
          goal: goal.trim(),
          risk_level: risk,
          max_additional_cycles: cycles,
          acceptance,
        }
      }
      inFlight.current = true
      setBusy(true)
      setLocked(true)
      const result = await post<{ accepted: boolean; mission_id: string }>(
        '/v1/missions',
        submission.current,
      )
      created(result.mission_id)
    } catch (failure) {
      if (failure instanceof ApiError && failure.missionId)
        setRegisteredId(failure.missionId)
      if (
        failure instanceof ApiError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.status !== 409
      ) {
        submission.current = null
        setLocked(false)
      }
      const message = failure instanceof Error ? failure.message : '提交未确认'
      setError(
        submission.current
          ? `${message}。请重试原请求，避免重复创建。`
          : message,
      )
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog title="新建目标" close={close} busy={busy} wide>
      <form
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        <div className="modal-body">
          <p className="muted">说明要完成什么，以及什么结果才算通过。</p>
          {error && (
            <div role="alert" className="error-box">
              {error}
              {registeredId && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => created(registeredId)}
                >
                  查看已登记目标
                </button>
              )}
            </div>
          )}
          <fieldset disabled={busy || locked} className="form-fields">
            <label>
              目标
              <textarea
                required
                maxLength={6000}
                rows={3}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="例如：核验样本数量，并生成可复核的报告"
              />
            </label>
            <div className="section-title">
              <h3>验收标准</h3>
              <span className="muted">每一项都必须有可核对的结果</span>
            </div>
            {criteria.map((criterion, index) => (
              <div className="criterion-form" key={index}>
                <label>
                  编号
                  <input
                    required
                    aria-label={`标准 ${index + 1} 编号`}
                    value={criterion.id}
                    onChange={(e) => update(index, { id: e.target.value })}
                  />
                </label>
                <label>
                  指标
                  <input
                    required
                    aria-label={`标准 ${index + 1} 指标`}
                    value={criterion.metric}
                    onChange={(e) => update(index, { metric: e.target.value })}
                    placeholder="例如 p95_ms"
                  />
                </label>
                <label>
                  比较
                  <select
                    value={criterion.operator}
                    aria-label={`标准 ${index + 1} 比较`}
                    onChange={(e) =>
                      update(index, {
                        operator: e.target.value as CriterionDraft['operator'],
                      })
                    }
                  >
                    {Object.entries(operatorLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  类型
                  <select
                    value={criterion.type}
                    aria-label={`标准 ${index + 1} 值类型`}
                    onChange={(e) =>
                      update(index, {
                        type: e.target.value as CriterionDraft['type'],
                        value: e.target.value === 'boolean' ? 'true' : '',
                      })
                    }
                  >
                    <option value="number">数字</option>
                    <option value="string">文本</option>
                    <option value="boolean">是 / 否</option>
                  </select>
                </label>
                <label>
                  期望值
                  {criterion.type === 'boolean' ? (
                    <select
                      aria-label={`标准 ${index + 1} 期望值`}
                      value={criterion.value}
                      onChange={(e) => update(index, { value: e.target.value })}
                    >
                      <option value="true">是</option>
                      <option value="false">否</option>
                    </select>
                  ) : (
                    <input
                      required={criterion.type !== 'string'}
                      aria-label={`标准 ${index + 1} 期望值`}
                      value={criterion.value}
                      onChange={(e) => update(index, { value: e.target.value })}
                    />
                  )}
                </label>
                <button
                  type="button"
                  className="icon-button remove"
                  disabled={criteria.length === 1}
                  aria-label={`移除标准 ${index + 1}`}
                  onClick={() =>
                    setCriteria((items) => items.filter((_, i) => i !== index))
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-button"
              disabled={criteria.length >= 50}
              onClick={() =>
                setCriteria((items) => [
                  ...items,
                  { ...initialCriterion(), id: `C${items.length + 1}` },
                ])
              }
            >
              ＋ 添加验收标准
            </button>
            <div className="form-row">
              <label>
                操作范围
                <select value={risk} onChange={(e) => setRisk(e.target.value)}>
                  <option value="read-meta">只读元数据</option>
                  <option value="read-sensitive">限定范围读取敏感内容</option>
                  <option value="controlled">受控副作用 · 需要审批</option>
                  <option value="mutating">代码或配置变更 · 需要审批</option>
                </select>
              </label>
              <label>
                最多额外返工轮数
                <input
                  type="number"
                  min={0}
                  max={10}
                  required
                  value={cycles}
                  onChange={(e) => setCycles(Number(e.target.value))}
                />
              </label>
            </div>
            <p className="hint">
              受控副作用与代码变更分别授权，批准其中一类不会放行另一类。
            </p>
          </fieldset>
        </div>
        <footer className="modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            返回
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '提交中…' : locked ? '重试原请求' : '创建并启动'}
          </button>
        </footer>
      </form>
    </Dialog>
  )
}

export function ApprovalDialog({
  approval,
  mission,
  actor,
  close,
  decided,
}: {
  approval: Approval
  mission: Mission | undefined
  actor: string | null
  close: () => void
  decided: () => void
}) {
  const scope = useRef(approval.scope).current
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<'approved' | 'rejected' | null>(null)
  const [advice, setAdvice] = useState<ApprovalAdviceV1 | null>(null)
  const [adviceBusy, setAdviceBusy] = useState(false)
  const [adviceError, setAdviceError] = useState('')
  const adviceRequest = useRef<AbortController | null>(null)
  useEffect(() => () => adviceRequest.current?.abort(), [])
  // ADR-0007 影子决定：只读账本记录，没有记录（未启用或尚未调用）时不显示。
  const [shadow, setShadow] = useState<JevDecisionV1 | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    request<JevDecisionV1>(
      `/v1/approvals/${encodeURIComponent(approval.id)}/jev-decision`,
      { signal: abort.signal },
    ).then(
      (record) => {
        if (!abort.signal.aborted) setShadow(record)
      },
      () => {},
    )
    return () => abort.abort()
  }, [approval.id])
  const inFlight = useRef(false)
  const expired = Date.parse(approval.expires_at) <= Date.now()
  const askAdvice = async () => {
    if (adviceRequest.current) return
    const abort = new AbortController()
    adviceRequest.current = abort
    setAdviceBusy(true)
    setAdviceError('')
    try {
      const response = await post<ApprovalAdviceV1>(
        `/v1/approvals/${encodeURIComponent(approval.id)}/advice`,
        {},
        abort.signal,
      )
      if (!abort.signal.aborted) setAdvice(response)
    } catch (failure) {
      if (!abort.signal.aborted)
        setAdviceError(
          failure instanceof Error ? failure.message : '辅助判断暂不可用',
        )
    } finally {
      adviceRequest.current = null
      if (!abort.signal.aborted) setAdviceBusy(false)
    }
  }
  const decide = async (decision: 'approved' | 'rejected') => {
    if (inFlight.current || result) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const payload = approvalPayload(approval, scope, decision, actor ?? '')
      await post(approvalURL(approval), payload)
      setResult(decision)
      decided()
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : '决定未提交，请重试',
      )
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={result ? '审批结果' : `仅处理 ${scope} 授权`}
      close={close}
      busy={busy}
    >
      <div className="modal-body">
        {result ? (
          <div className="decision-result">
            <span
              className={`result-mark ${result === 'approved' ? 'success' : 'neutral'}`}
            >
              {result === 'approved' ? '✓' : '—'}
            </span>
            <h3>
              {result === 'approved' ? '已批准' : '已拒绝'} {scope}
            </h3>
            <p>仅此请求已处理。另一类授权没有变化。</p>
            <p className="muted">不会自动打开下一项审批。</p>
          </div>
        ) : (
          <>
            <div className={`scope-banner ${scope}`}>
              <strong>
                {scope === 'controlled' ? '受控副作用' : '代码 / 配置变更'}
              </strong>
              <code>{scope}</code>
            </div>
            <h3>{mission?.goal ?? '关联目标'}</h3>
            <dl className="detail-grid">
              <dt>请求动作</dt>
              <dd>{approval.action}</dd>
              <dt>请求方</dt>
              <dd>{approval.requested_by}</dd>
              <dt>原因</dt>
              <dd>{approval.reason}</dd>
              <dt>截止时间</dt>
              <dd>
                {showTime(approval.expires_at)}
                {expired ? ' · 已过期' : ''}
              </dd>
              <dt>关联证据</dt>
              <dd>
                {approval.evidence_artifact_ids.length
                  ? approval.evidence_artifact_ids.join('、')
                  : '未附证据'}
              </dd>
              <dt>{oidcEnabled ? '登录操作者' : '本机操作者'}</dt>
              <dd>{actor ?? '未配置'}</dd>
            </dl>
            <p className="hint">
              只决定当前范围。批准 {scope} 不代表批准{' '}
              {scope === 'controlled' ? 'mutating' : 'controlled'}。
            </p>
            {shadow && (
              <section className="advice-box" aria-label="Jev 影子决定">
                <div className="advice-heading">
                  <strong>Jev 影子决定（仅记录）</strong>
                </div>
                <p className="advice-result">
                  决定：
                  {
                    {
                      approve: '通过',
                      reject: '拒绝',
                      escalate: '转人工',
                      assign: '分配',
                      retry: '重做',
                    }[shadow.outcome]
                  }
                  {' · 自评风险 '}
                  {shadow.assessed_risk ?? '无'}
                  {shadow.confidence !== null
                    ? ` · 置信度 ${Math.round(shadow.confidence * 100)}%`
                    : ''}
                </p>
                <p className="muted small">
                  理由码 <code>{shadow.reason_code}</code> ·{' '}
                  {shadow.model ?? '模型不可用'}
                  。影子模式只记录，不改变审批，仍由你决定。
                </p>
              </section>
            )}
            <section className="advice-box" aria-label="Jev 辅助判断">
              <div className="advice-heading">
                <strong>Jev 辅助判断</strong>
                <button
                  className="secondary"
                  disabled={adviceBusy || busy}
                  onClick={() => {
                    void askAdvice()
                  }}
                >
                  {adviceBusy
                    ? '判断中…'
                    : advice
                      ? '重新获取建议'
                      : '获取 Jev 建议'}
                </button>
              </div>
              {advice && (
                <>
                  <p className="advice-result">
                    建议：
                    {
                      {
                        continue: '可继续（仅建议）',
                        review: '需要复核',
                        reject: '不应执行',
                        insufficient: '信息不足',
                      }[advice.recommendation]
                    }
                  </p>
                  <p className="muted small">
                    {advice.model ?? '模型不可用'}
                    {advice.confidence !== null
                      ? ` · 置信度 ${Math.round(advice.confidence * 100)}%`
                      : ''}
                    。仍需你确认当前授权，不会自动批准。
                  </p>
                </>
              )}
              {!advice && (
                <p className="muted small">
                  按当前请求生成独立建议，不改变审批状态。
                </p>
              )}
              {adviceError && (
                <p role="alert" className="danger-text small">
                  {adviceError}
                </p>
              )}
            </section>
            <p className="muted small">
              {oidcEnabled
                ? '操作者取自登录令牌，服务端按令牌记录审批人。'
                : '当前为本机模式，按本机配置记录操作者，尚未接入身份认证。'}
            </p>
          </>
        )}
        {error && (
          <div role="alert" className="error-box">
            {error}
          </div>
        )}
      </div>
      <footer className="modal-actions">
        {result ? (
          <button className="primary" onClick={close}>
            返回审批列表
          </button>
        ) : (
          <>
            <button
              className="secondary danger-text"
              disabled={busy || !actor}
              onClick={() => {
                void decide('rejected')
              }}
            >
              拒绝此请求
            </button>
            <button
              className="primary approval-action"
              disabled={busy || expired || !actor}
              onClick={() => {
                void decide('approved')
              }}
            >
              {busy ? '提交中…' : `仅批准 ${scope}`}
            </button>
          </>
        )}
      </footer>
    </Dialog>
  )
}

export function ArtifactDialog({
  artifact,
  close,
}: {
  artifact: Artifact
  close: () => void
}) {
  const [data, setData] = useState<{
    text: string | null
    url: string
    image: boolean
  } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    let url: string | undefined
    void (async () => {
      try {
        const response = await fetch(artifactURL(artifact), {
          signal: abort.signal,
          headers: authHeaders(),
        })
        if (!response.ok) {
          const body = await response.json()
          throw new Error(body.error ?? '证据无法读取')
        }
        const bytes = await response.arrayBuffer()
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        const sha = [...new Uint8Array(digest)]
          .map((x) => x.toString(16).padStart(2, '0'))
          .join('')
        if (
          sha !== artifact.sha256.toLowerCase() ||
          response.headers.get('x-content-sha256') !== sha
        )
          throw new Error('证据哈希与账本不一致，已停止预览')
        if (abort.signal.aborted) return
        const image = ['image/png', 'image/jpeg', 'image/webp'].includes(
          artifact.media_type,
        )
        let text: string | null = null
        if (!image) {
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          } catch {
            /* 二进制可下载，不伪装成文本 */
          }
        }
        url = URL.createObjectURL(
          new Blob([bytes], {
            type: image ? artifact.media_type : 'application/octet-stream',
          }),
        )
        setData({ text, url, image })
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(failure instanceof Error ? failure.message : '证据读取失败')
      }
    })()
    return () => {
      abort.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [artifact])
  const filename = artifact.uri.split('/').at(-1) || 'evidence'
  return (
    <Dialog title={`证据 · ${artifact.role}`} close={close} wide>
      <div className="modal-body">
        <p className="muted break-word">{artifact.artifact_id}</p>
        {error ? (
          <div className="error-box" role="alert">
            {error}
          </div>
        ) : !data ? (
          <p role="status">正在读取并核对证据…</p>
        ) : (
          <>
            <div className="verified-line">
              <span className="badge success">✓ 哈希核对通过</span>
              <span>{artifact.size_bytes.toLocaleString()} 字节</span>
            </div>
            {data.image ? (
              <img
                className="evidence-image"
                src={data.url}
                alt={`${artifact.role} 证据`}
              />
            ) : data.text !== null ? (
              <pre className="evidence-text">
                {data.text.slice(0, 65_536)}
                {data.text.length > 65_536
                  ? '\n…预览已截断，完整内容请下载。'
                  : ''}
              </pre>
            ) : (
              <p>此格式不提供文本预览，可下载查看。</p>
            )}
            <dl className="detail-grid">
              <dt>SHA-256</dt>
              <dd className="hash">{artifact.sha256}</dd>
            </dl>
          </>
        )}
      </div>
      <footer className="modal-actions">
        <button className="secondary" onClick={close}>
          关闭
        </button>
        {data && (
          <a
            className="primary button-link"
            href={data.url}
            download={filename}
          >
            下载已核对的文件
          </a>
        )}
      </footer>
    </Dialog>
  )
}
