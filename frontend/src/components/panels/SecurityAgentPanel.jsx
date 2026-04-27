import { useState, useEffect } from 'react'
import { callTool } from '../../api/mcpClient'
import { AGENT_STEPS } from '../../utils/constants'

function PhasePill({ phase }) {
  const map = {
    idle:               ['muted',   'IDLE'],
    thinking:           ['blue',    'THINKING'],
    awaiting_approval:  ['warning', 'AWAITING APPROVAL'],
    applying:           ['blue',    'APPLYING'],
    complete:           ['success', 'COMPLETE'],
    failed:             ['error',   'FAILED'],
  }
  const [cls, label] = map[phase] || map.idle
  return <span className={'aca-badge ' + cls}>{label}</span>
}

function AgentPhaseSteps({ step, done = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {AGENT_STEPS.map((s, i) => {
        const state = done || i < step ? 'past' : i === step ? 'current' : 'future'
        const sym   = state === 'past' ? '✓' : state === 'current' ? '›' : '○'
        const color = state === 'past' ? 'var(--success)' : state === 'current' ? 'var(--accent-blue)' : 'var(--text-muted)'
        return (
          <div key={i} style={{
            display: 'flex', gap: 10, color,
            fontSize: 12, opacity: state === 'future' ? 0.55 : 1,
            transition: 'opacity 0.3s ease, color 0.3s ease',
          }}>
            <span className="mono" style={{ width: 14, textAlign: 'center' }}>{sym}</span>
            <span style={{ color: state === 'future' ? 'var(--text-muted)' : 'var(--text-primary)' }}>{s}</span>
          </div>
        )
      })}
    </div>
  )
}

export default function SecurityAgentPanel({ region, model, apiKey }) {
  const [phase,    setPhase]    = useState('idle')
  const [step,     setStep]     = useState(0)
  const [data,     setData]     = useState(null)
  const [result,   setResult]   = useState(null)
  const [showHcl,  setShowHcl]  = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const [error,    setError]    = useState(null)

  useEffect(() => {
    if (phase !== 'thinking' && phase !== 'applying') return
    const id = setInterval(() => setStep((s) => Math.min(s + 1, AGENT_STEPS.length - 1)), 1200)
    return () => clearInterval(id)
  }, [phase])

  const run = async () => {
    setPhase('thinking'); setStep(0); setData(null); setResult(null); setError(null)
    try {
      const r = await callTool('agent_run', { region, model, api_key: apiKey })
      setData(r)
      setPhase(r.status === 'awaiting_approval' ? 'awaiting_approval' : 'idle')
    } catch (e) { setError(String(e)); setPhase('failed') }
  }

  const approve = async () => {
    setPhase('applying'); setStep(0)
    try {
      const r = await callTool('agent_approve', { execution_id: data.execution_id, approved: true })
      setResult(r)
      setPhase(r.status === 'complete' ? 'complete' : 'failed')
      if (r.status !== 'complete') setError(r.error || 'Apply failed')
    } catch (e) { setError(String(e)); setPhase('failed') }
  }

  const reject = () => {
    callTool('agent_approve', { execution_id: data.execution_id, approved: false }).catch(() => {})
    setPhase('idle'); setData(null)
  }

  return (
    <section className="aca-panel" style={{ gridColumn: 'span 12' }}>
      <div className="aca-panel-hd">
        <div className="aca-row" style={{ gap: 10 }}>
          <span className="aca-panel-title">Security Agent</span>
          <PhasePill phase={phase} />
        </div>
      </div>
      <div className="aca-panel-body">
        {phase === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.55, maxWidth: 640 }}>
              The agent runs a full scan, picks the highest-severity finding, generates a Terraform fix,
              plans it, and pauses for your approval before applying. One issue per run.
            </p>
            <div><button className="aca-btn-primary" onClick={run}>▶ Run Agent</button></div>
          </div>
        )}

        {phase === 'thinking' && (
          <div style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 24, display: 'flex', flexDirection: 'column', gap: 18,
          }}>
            <div className="aca-row" style={{ gap: 10, color: 'var(--accent-blue)', fontSize: 12 }}>
              <span className="aca-dots blue"><span /><span /><span /></span>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>Agent running</span>
            </div>
            <AgentPhaseSteps step={step} />
          </div>
        )}

        {phase === 'awaiting_approval' && data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ borderLeft: '2px solid var(--warning)', padding: '8px 14px', background: 'var(--bg-panel)' }}>
              <div className="aca-row" style={{ gap: 10, marginBottom: 6 }}>
                <span className={'aca-badge ' + data.issue.severity.toLowerCase()}>{data.issue.severity}</span>
                <strong style={{ color: 'var(--text-primary)', fontSize: 14 }}>{data.issue.title}</strong>
              </div>
              <p style={{ margin: '6px 0', color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.55 }}>
                {data.issue.description}
              </p>
              <div className="mono" style={{ color: 'var(--text-muted)', fontSize: 11 }}>{data.issue.resource_id}</div>
            </div>

            <div className="aca-summary">{data.summary}</div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="aca-btn-ghost small" onClick={() => setShowHcl((v) => !v)}>
                {showHcl ? '▾' : '▸'} Terraform HCL
              </button>
              <button className="aca-btn-ghost small" onClick={() => setShowPlan((v) => !v)}>
                {showPlan ? '▾' : '▸'} Plan output
              </button>
            </div>
            {showHcl  && <pre className="aca-code" style={{ maxHeight: 260, margin: 0 }}>{data.hcl}</pre>}
            {showPlan && <pre className="aca-code" style={{ maxHeight: 200, margin: 0 }}>{data.plan_output}</pre>}

            <div style={{
              background: 'var(--warning-dim)', border: '1px solid var(--warning)',
              borderRadius: 6, padding: '10px 14px', color: 'var(--warning)', fontSize: 12,
            }}>
              ⚠ This will modify your live AWS infrastructure.
            </div>

            <div className="aca-row" style={{ gap: 8 }}>
              <button className="aca-btn-primary" onClick={approve}>Approve & Apply</button>
              <button className="aca-btn-ghost small" onClick={reject}>Reject</button>
            </div>
          </div>
        )}

        {phase === 'applying' && (
          <div style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 24,
          }}>
            <div className="aca-row" style={{ gap: 10, color: 'var(--accent-blue)', fontSize: 13 }}>
              <span className="aca-dots blue"><span /><span /><span /></span>
              <span>Applying changes to AWS…</span>
            </div>
          </div>
        )}

        {phase === 'complete' && result && (
          <div style={{
            background: 'var(--success-dim)', border: '1px solid var(--success)',
            borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            <div className="aca-row" style={{ gap: 10 }}>
              <span className="aca-badge success">✓ COMPLETE</span>
              <span style={{ color: 'var(--text-primary)', fontSize: 13 }}>Finding remediated successfully.</span>
            </div>
            <pre className="aca-code" style={{ maxHeight: 260, margin: 0, color: 'var(--success)' }}>
              {result.apply_output}
            </pre>
            <div>
              <button className="aca-btn-ghost small"
                onClick={() => { setPhase('idle'); setData(null); setResult(null) }}>
                ↩ Run Again
              </button>
            </div>
          </div>
        )}

        {phase === 'failed' && (
          <div style={{
            background: 'var(--error-dim)', border: '1px solid var(--error)',
            borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div className="aca-row" style={{ gap: 10 }}>
              <span className="aca-badge error">✗ FAILED</span>
              <span style={{ color: 'var(--text-primary)', fontSize: 13 }}>{error || 'Agent failed'}</span>
            </div>
            <div><button className="aca-btn-ghost small" onClick={run}>Retry</button></div>
          </div>
        )}
      </div>
    </section>
  )
}
