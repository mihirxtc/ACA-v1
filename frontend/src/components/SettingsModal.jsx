import { useState, useCallback } from 'react'
import { useApiKeys } from '../contexts/ApiKeyContext'
import { useRecommendations } from '../hooks/useRecommendations'
import Field from './ui/Field'

const ONBOARDING_USE_OPTIONS = [
  { value: 'chat',     label: 'General AWS chat' },
  { value: 'security', label: 'Security audits & compliance' },
  { value: 'iac',      label: 'Terraform / IaC generation' },
  { value: 'agent',    label: 'Autonomous agent tasks' },
]

const ONBOARDING_LATENCY_OPTIONS = [
  { value: 'fast',     label: 'Speed — fast responses' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'quality',  label: 'Quality — I\'ll wait for better answers' },
]

function OnboardingQuestions({ onComplete }) {
  const [primaryUse, setPrimaryUse]   = useState(null)
  const [latencyPref, setLatencyPref] = useState(null)

  const handleComplete = useCallback((use, latency) => {
    const prefs = { primary_use: use, latency_pref: latency }
    try { localStorage.setItem('aca_user_preferences', JSON.stringify(prefs)) } catch {}
    onComplete(prefs)
  }, [onComplete])

  const handleLatency = (val) => {
    setLatencyPref(val)
    if (primaryUse) handleComplete(primaryUse, val)
  }

  const handleUse = (val) => {
    setPrimaryUse(val)
    if (latencyPref) handleComplete(val, latencyPref)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          What will you primarily use ACA for?
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ONBOARDING_USE_OPTIONS.map((opt) => (
            <label key={opt.value} style={{
              display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
              fontSize: 13, color: primaryUse === opt.value ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}>
              <input
                type="radio" name="primary_use" value={opt.value}
                checked={primaryUse === opt.value}
                onChange={() => handleUse(opt.value)}
                style={{ accentColor: 'var(--accent)' }}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          What matters more right now?
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ONBOARDING_LATENCY_OPTIONS.map((opt) => (
            <label key={opt.value} style={{
              display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
              fontSize: 13, color: latencyPref === opt.value ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}>
              <input
                type="radio" name="latency_pref" value={opt.value}
                checked={latencyPref === opt.value}
                onChange={() => handleLatency(opt.value)}
                style={{ accentColor: 'var(--accent)' }}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

function RecommendationCard({ rec, rank, installState, onInstall }) {
  const isTop      = rank === 1
  const installing = installState?.status === 'installing'
  const done       = installState?.status === 'done'
  const authErr    = installState?.status === 'auth_required'
  const progress   = installState?.progress ?? 0

  return (
    <div style={{
      border: isTop ? '1px solid var(--accent)' : '1px solid var(--border)',
      borderRadius: 8, padding: isTop ? 14 : 10,
      opacity: isTop ? 1 : 0.75,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {isTop && (
        <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: '0.04em' }}>
          ★ Recommended for you
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: isTop ? 14 : 13, fontWeight: 600 }}>{rec.model_id}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Score: {rec.score.toFixed(2)}</span>
      </div>
      {isTop && rec.explanation && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
          {rec.explanation}
        </p>
      )}
      {isTop && rec.top_features && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Why: {rec.top_features[0]?.replace(/_/g, ' ')} ({rec.feature_breakdown?.[rec.top_features[0]]?.toFixed(2)})
          {' · '}{rec.top_features[1]?.replace(/_/g, ' ')} ({rec.feature_breakdown?.[rec.top_features[1]]?.toFixed(2)})
        </div>
      )}

      {installing && (
        <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%', background: 'var(--accent)',
            width: `${progress}%`, transition: 'width 0.3s ease',
          }} />
        </div>
      )}
      {authErr && (
        <div style={{ fontSize: 11, color: 'var(--danger)' }}>
          Sign in required — run <code>ollama signin</code> first
        </div>
      )}

      {done ? (
        <div style={{ fontSize: 12, color: 'var(--success, #4caf50)' }}>✓ Installed</div>
      ) : (
        <button
          className={isTop ? 'aca-btn-primary' : 'aca-btn-ghost small'}
          style={isTop ? { width: '100%' } : {}}
          onClick={() => onInstall(rec.model_id)}
          disabled={installing}
        >
          {installing ? `Installing… ${progress}%` : 'Install — takes ~5s'}
        </button>
      )}
    </div>
  )
}

function OllamaModelsSection({ ollamaUrl, installedModels, onModelInstalled }) {
  const [userPrefs, setUserPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('aca_user_preferences')) || null } catch { return null }
  })
  const [visible, setVisible] = useState(true)
  const showOnboarding = !userPrefs

  const { recommendations, loading } = useRecommendations(userPrefs, 'none')

  const [installStates, setInstallStates] = useState({})

  const handleInstall = useCallback(async (modelId) => {
    setInstallStates((s) => ({ ...s, [modelId]: { status: 'installing', progress: 0 } }))
    try {
      const base = ollamaUrl || 'http://localhost:11434'
      const res = await fetch('/api/ollama/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: modelId, base_url: base }),
      })
      if (!res.ok || !res.body) throw new Error('pull_failed')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const lines = decoder.decode(value).split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const evt = JSON.parse(line)
            if (evt.error === 'auth_required') {
              setInstallStates((s) => ({ ...s, [modelId]: { status: 'auth_required', progress: 0 } }))
              return
            }
            if (typeof evt.progress === 'number') {
              setInstallStates((s) => ({ ...s, [modelId]: { status: 'installing', progress: evt.progress } }))
            }
          } catch {}
        }
      }
      setInstallStates((s) => ({ ...s, [modelId]: { status: 'done', progress: 100 } }))
      onModelInstalled(modelId)
    } catch {
      setInstallStates((s) => ({ ...s, [modelId]: { status: 'error', progress: 0 } }))
    }
  }, [ollamaUrl, onModelInstalled])

  const hasInstalled = installedModels.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>
          {hasInstalled ? 'Ollama cloud models' : 'Install a model'}
        </span>
        {hasInstalled && userPrefs && (
          <button
            className="aca-btn-ghost small"
            style={{ fontSize: 11 }}
            onClick={() => {
              localStorage.removeItem('aca_user_preferences')
              setUserPrefs(null)
            }}
          >
            Re-tune recommendations
          </button>
        )}
      </div>

      {!hasInstalled && showOnboarding && (
        <div style={{
          opacity: visible ? 1 : 0,
          transition: 'opacity 0.2s ease',
        }}>
          <OnboardingQuestions onComplete={(prefs) => {
            setVisible(false)
            setTimeout(() => { setUserPrefs(prefs); setVisible(true) }, 200)
          }} />
        </div>
      )}

      {userPrefs && (
        <div style={{
          opacity: visible ? 1 : 0,
          transition: 'opacity 0.2s ease',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {loading ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
              Loading recommendations…
            </div>
          ) : recommendations.length > 0 ? (
            recommendations.map((rec) => (
              <RecommendationCard
                key={rec.model_id}
                rec={rec}
                rank={rec.rank}
                installState={installStates[rec.model_id]}
                onInstall={handleInstall}
              />
            ))
          ) : null}
        </div>
      )}
    </div>
  )
}

export default function SettingsModal({ onClose }) {
  const { keys, setAllKeys, clearAllKeys } = useApiKeys()
  const [tab,   setTab]   = useState('CLOUD')
  const [draft, setDraft] = useState(keys)
  const [flash, setFlash] = useState(false)
  const [installedOllamaModels, setInstalledOllamaModels] = useState([])

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }))

  const save = () => {
    setAllKeys(draft)
    setFlash(true)
    setTimeout(() => { setFlash(false); onClose() }, 1200)
  }

  const handleClear = () => {
    clearAllKeys()
    onClose()
  }

  const handleModelInstalled = useCallback((modelId) => {
    setInstalledOllamaModels((prev) => prev.includes(modelId) ? prev : [...prev, modelId])
  }, [])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 460, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-panel)', border: '1px solid var(--border-bright)',
        borderRadius: 12, overflow: 'hidden',
      }}>
        <div className="aca-panel-hd" style={{ padding: '14px 20px' }}>
          <span className="aca-panel-title">Settings</span>
          <button className="aca-btn-ghost small" onClick={onClose}>×</button>
        </div>
        <div style={{ padding: '0 20px' }}>
          <div className="aca-tab-bar">
            <button className="aca-tab" data-active={tab === 'CLOUD'} onClick={() => setTab('CLOUD')}>
              Cloud credentials
            </button>
            <button className="aca-tab" data-active={tab === 'LLM'} onClick={() => setTab('LLM')}>
              LLM keys
            </button>
          </div>
        </div>
        <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {tab === 'CLOUD' ? (
            <>
              <div style={{
                background: 'var(--bg-elevated)', padding: '8px 12px',
                borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12,
              }}>
                Blank = uses ~/.aws/credentials
              </div>
              <Field label="AWS Access Key ID" saved={!!keys.aws_access_key}>
                <input className="aca-input" type="password"
                  value={draft.aws_access_key || ''}
                  onChange={(e) => set('aws_access_key', e.target.value)} />
              </Field>
              <Field label="AWS Secret Access Key" saved={!!keys.aws_secret_key}>
                <input className="aca-input" type="password"
                  value={draft.aws_secret_key || ''}
                  onChange={(e) => set('aws_secret_key', e.target.value)} />
              </Field>
              <Field label="AWS Region">
                <select className="aca-select"
                  value={draft.region || 'us-east-1'}
                  onChange={(e) => set('region', e.target.value)}>
                  <option>us-east-1</option>
                  <option>eu-west-1</option>
                  <option>ap-southeast-1</option>
                  <option>ap-southeast-2</option>
                </select>
              </Field>
            </>
          ) : (
            <>
              <div style={{
                background: 'var(--bg-elevated)', padding: '8px 12px',
                borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12,
              }}>
                Keys stored in browser only.
              </div>
              <Field label="Default model">
                <select className="aca-select"
                  value={draft.model || 'groq'}
                  onChange={(e) => set('model', e.target.value)}>
                  <option value="groq">Groq</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="ollama">Ollama</option>
                  {installedOllamaModels.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </Field>
              <Field label="Groq API key" saved={!!keys.groq_key} hint="Used for fast inference and chat">
                <input className="aca-input" type="password"
                  value={draft.groq_key || ''}
                  onChange={(e) => set('groq_key', e.target.value)} />
              </Field>
              <Field label="Anthropic API key" saved={!!keys.anthropic_key} hint="Used for agent reasoning">
                <input className="aca-input" type="password"
                  value={draft.anthropic_key || ''}
                  onChange={(e) => set('anthropic_key', e.target.value)} />
              </Field>
              <Field label="Ollama URL" hint="Local inference endpoint">
                <input className="aca-input"
                  placeholder="http://localhost:11434"
                  value={draft.ollama_url || ''}
                  onChange={(e) => set('ollama_url', e.target.value)} />
              </Field>
              {(draft.model === 'ollama' || installedOllamaModels.length > 0) && (
                <OllamaModelsSection
                  ollamaUrl={draft.ollama_url}
                  installedModels={installedOllamaModels}
                  onModelInstalled={handleModelInstalled}
                />
              )}
            </>
          )}
        </div>
        <div style={{
          padding: '14px 20px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', gap: 8,
        }}>
          <button className="aca-btn-ghost small danger" onClick={handleClear}>Clear all</button>
          <div className="aca-row" style={{ gap: 8 }}>
            <button className="aca-btn-ghost small" onClick={onClose}>Cancel</button>
            <button className="aca-btn-primary" onClick={save}>
              {flash ? '✓ Saved' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
