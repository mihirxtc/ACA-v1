import { useState, useEffect } from 'react'
import { callTool } from '../../api/mcpClient'
import { QUICK_REQUESTS, sleep } from '../../utils/constants'

function ExecutionInline({ result }) {
  const [phase,  setPhase]  = useState('plan')
  const [output, setOutput] = useState('Initializing plan…')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await sleep(900)
      if (cancelled) return
      setOutput(
        `# terraform plan\nTerraform will perform the following actions:\n` +
        `  + ${result?.resource_type?.split('+')[0]?.trim() || 'aws_resource'}\n\n` +
        `Plan: 1 to add, 0 to change, 0 to destroy.`
      )
      setPhase('approve')
    })()
    return () => { cancelled = true }
  }, []) // eslint-disable-line

  const approve = async () => {
    setPhase('applying')
    setOutput((o) => o + '\n\n# terraform apply\nApplying…')
    await sleep(1200)
    setOutput((o) => o + '\nApply complete! Resources: 1 added, 0 changed, 0 destroyed.')
    setPhase('done')
  }

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14,
      display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg-elevated)',
    }}>
      <div className="aca-row" style={{ justifyContent: 'space-between' }}>
        <span className="aca-panel-title">Execution</span>
        <span className={'aca-badge ' + (phase === 'done' ? 'success' : phase === 'approve' ? 'warning' : 'blue')}>
          {phase === 'plan' ? 'PLANNING' : phase === 'approve' ? 'AWAITING APPROVAL' :
           phase === 'applying' ? 'APPLYING' : 'COMPLETE'}
        </span>
      </div>
      <pre className="aca-code" style={{ maxHeight: 220, margin: 0 }}>{output}</pre>
      {phase === 'approve' && (
        <div className="aca-row" style={{ gap: 8 }}>
          <button className="aca-btn-primary" onClick={approve}>Approve & Apply</button>
          <button className="aca-btn-ghost small" onClick={() => setPhase('done')}>Reject</button>
        </div>
      )}
    </div>
  )
}

export default function TerraformPanel({ model, apiKey, prefill, onPrefillConsumed }) {
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [result,   setResult]   = useState(null)
  const [copied,   setCopied]   = useState(false)
  const [showExec, setShowExec] = useState(false)

  useEffect(() => {
    if (prefill) {
      setInput(prefill)
      setResult(null)
      setShowExec(false)
      onPrefillConsumed?.()
    }
  }, [prefill]) // eslint-disable-line

  const generate = async (req) => {
    const request = (req ?? input).trim()
    if (!request || loading) return
    if (req) setInput(req)
    setLoading(true)
    setResult(null)
    setShowExec(false)
    try {
      const r = await callTool('generate_terraform_from_request', { request, model, api_key: apiKey })
      setResult(r)
    } finally { setLoading(false) }
  }

  const copy = () => {
    if (!result) return
    navigator.clipboard?.writeText(result.hcl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const download = () => {
    const blob = new Blob([result.hcl], { type: 'text/plain' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = 'main.tf'
    a.click()
    URL.revokeObjectURL(url)
  }

  const modelBadge = model === 'groq' ? 'GROQ' : model === 'anthropic' ? 'ANTHROPIC' : 'OLLAMA'

  return (
    <section id="terraform-panel" className="aca-panel" style={{ gridColumn: 'span 12' }}>
      <div className="aca-panel-hd">
        <div className="aca-row" style={{ gap: 10 }}>
          <span className="aca-panel-title">Terraform Generator</span>
          <span className="aca-badge blue">{modelBadge}</span>
        </div>
      </div>
      <div className="aca-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {QUICK_REQUESTS.map((q) => (
            <button key={q} className="aca-pill-btn" onClick={() => generate(q)}>{q}</button>
          ))}
        </div>
        <div className="aca-row" style={{ gap: 8 }}>
          <input
            className="aca-input"
            placeholder="Describe the resource you want to create…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') generate() }}
          />
          <button className="aca-btn-primary"
            onClick={() => generate()} disabled={loading || !input.trim()}
            style={{ whiteSpace: 'nowrap' }}>
            {loading ? 'Generating…' : 'Generate'}
          </button>
        </div>

        {loading && <div className="aca-skel" style={{ height: 260 }} />}

        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="aca-row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <span className="aca-badge muted mono">{result.resource_type}</span>
              <span className={'aca-badge ' + (result.validation?.valid ? 'success' : 'error')}>
                {result.validation?.valid ? '✓ VALIDATED' : '✗ INVALID'}
              </span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{result.description}</span>
            </div>

            {result.naming_note && (
              <div style={{
                background: 'var(--warning-dim)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '8px 12px', color: 'var(--warning)', fontSize: 12,
              }}>
                ℹ {result.naming_note}
              </div>
            )}

            <div style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 2, display: 'flex', gap: 6 }}>
                <button className="aca-btn-ghost small"
                  style={{ background: 'var(--bg-elevated)' }}
                  onClick={download}>
                  ↓ Download
                </button>
                <button className="aca-btn-ghost small" onClick={copy}
                  style={{ background: 'var(--bg-elevated)' }}>
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <pre className="aca-code" style={{ maxHeight: 360, margin: 0 }}>{result.hcl}</pre>
            </div>

            <div>
              <button className="aca-btn-primary" onClick={() => setShowExec(true)} disabled={showExec}>
                🚀 Run Plan & Deploy
              </button>
            </div>

            {showExec && <ExecutionInline result={result} />}
          </div>
        )}
      </div>
    </section>
  )
}
